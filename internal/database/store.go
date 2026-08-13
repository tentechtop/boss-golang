package database

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"boss-job-assistant/internal/domain"

	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/util"
)

const (
	maxStoredJobs             = 2000
	maxStoredQueueItems       = 2000
	maxStoredFeedbacks        = 1000
	maxJobDescriptionRunes    = 900
	maxJobRequirementItems    = 12
	maxQueueFilterReasonItems = 8
	maxTextFieldRunes         = 500
)

const (
	keyProjectPrefix        = "project/"
	keyResumePrefix         = "resume/"
	keyJobPrefix            = "job/"
	keyQueueItemPrefix      = "queue/"
	keyFeedbackPrefix       = "feedback/"
	keyDeliveryStrategy     = "meta/delivery_strategy"
	keyAutomationControl    = "meta/automation_control"
	keyAutomationStatus     = "meta/automation_status"
	keyAIReplySettings      = "meta/ai_reply_settings"
	generatedProjectPrefix  = "project"
	generatedResumePrefix   = "resume"
	generatedJobPrefix      = "job"
	generatedQueuePrefix    = "queue"
	generatedFeedbackPrefix = "feedback"
)

type Store struct {
	filePath string
	dbPath   string
	handle   *sharedLevelDatabase
}

type sharedLevelDatabase struct {
	database *leveldb.DB
	mutex    sync.RWMutex
	refs     int
}

type appData struct {
	Projects          []domain.ProjectSummary    `json:"projects"`
	Resumes           []domain.ResumeVersion     `json:"resumes"`
	Jobs              []domain.JobAnalysis       `json:"jobs"`
	QueueItems        []domain.DeliveryQueueItem `json:"queueItems"`
	Feedbacks         []domain.FeedbackRecord    `json:"feedbacks"`
	DeliveryStrategy  domain.DeliveryStrategy    `json:"deliveryStrategy"`
	AutomationControl domain.AutomationControl   `json:"automationControl"`
	AutomationStatus  domain.AutomationStatus    `json:"automationStatus"`
	AIReplySettings   domain.AIReplySettings     `json:"aiReplySettings"`
}

var sharedLevelDatabases = struct {
	mutex  sync.Mutex
	byPath map[string]*sharedLevelDatabase
}{
	byPath: make(map[string]*sharedLevelDatabase),
}

func Open(filePath string) (*Store, error) {
	if mkdirErr := os.MkdirAll(filepath.Dir(filePath), 0755); mkdirErr != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", mkdirErr)
	}

	dbPath, pathErr := filepath.Abs(filePath + ".leveldb")
	if pathErr != nil {
		return nil, fmt.Errorf("解析数据存储路径失败: %w", pathErr)
	}

	handle, openErr := openSharedLevelDatabase(dbPath)
	if openErr != nil {
		return nil, openErr
	}

	store := &Store{
		filePath: filePath,
		dbPath:   dbPath,
		handle:   handle,
	}
	if bootstrapErr := store.bootstrap(); bootstrapErr != nil {
		_ = store.Close()
		return nil, bootstrapErr
	}

	return store, nil
}

func (store *Store) Close() error {
	if store == nil || store.handle == nil {
		return nil
	}

	sharedLevelDatabases.mutex.Lock()
	handle := store.handle
	store.handle = nil

	if handle.refs > 1 {
		handle.refs--
		sharedLevelDatabases.mutex.Unlock()
		return nil
	}

	delete(sharedLevelDatabases.byPath, store.dbPath)
	handle.refs = 0
	sharedLevelDatabases.mutex.Unlock()

	if closeErr := handle.database.Close(); closeErr != nil {
		return fmt.Errorf("关闭数据存储失败: %w", closeErr)
	}
	return nil
}

func (store *Store) SaveProjects(projects []domain.ProjectSummary) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	existingProjects, listErr := store.listProjectsLocked()
	if listErr != nil {
		return fmt.Errorf("读取项目列表失败: %w", listErr)
	}

	for _, projectSummary := range projects {
		if saveErr := store.upsertProjectLocked(projectSummary, &existingProjects); saveErr != nil {
			return saveErr
		}
	}
	return nil
}

func (store *Store) ListProjects() []domain.ProjectSummary {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	projects, listErr := store.listProjectsLocked()
	panicOnReadError("读取项目列表失败", listErr)
	return projects
}

func (store *Store) GetProjectsByID(projectIDs []string) []domain.ProjectSummary {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	projects, listErr := store.listProjectsLocked()
	panicOnReadError("读取项目列表失败", listErr)

	idSet := make(map[string]struct{}, len(projectIDs))
	for _, projectID := range projectIDs {
		idSet[projectID] = struct{}{}
	}

	matchedProjects := make([]domain.ProjectSummary, 0, len(projectIDs))
	for _, projectSummary := range projects {
		if _, exists := idSet[projectSummary.ID]; exists {
			matchedProjects = append(matchedProjects, projectSummary)
		}
	}
	return matchedProjects
}

func (store *Store) SaveResume(resumeVersion domain.ResumeVersion) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	resumeVersion.ID = normalizeRecordID(resumeVersion.ID, resumeVersion.Name+resumeVersion.CreatedAt.String(), generatedResumePrefix)
	if saveErr := setRecordLocked(store.handle.database, keyResumePrefix+resumeVersion.ID, resumeVersion); saveErr != nil {
		return fmt.Errorf("保存简历失败: %w", saveErr)
	}
	return nil
}

func (store *Store) ListResumes() []domain.ResumeVersion {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	resumes, listErr := store.listResumesLocked()
	panicOnReadError("读取简历列表失败", listErr)
	return resumes
}

func (store *Store) GetResume(resumeID string) (domain.ResumeVersion, bool) {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	resumeVersion, exists, getErr := getRecordLocked[domain.ResumeVersion](store.handle.database, keyResumePrefix+resumeID)
	panicOnReadError("读取简历失败", getErr)
	return resumeVersion, exists
}

func (store *Store) SaveJob(jobAnalysis domain.JobAnalysis) error {
	_, saveErr := store.SaveJobsAndReturn([]domain.JobAnalysis{jobAnalysis})
	return saveErr
}

func (store *Store) SaveJobs(jobAnalyses []domain.JobAnalysis) error {
	_, saveErr := store.SaveJobsAndReturn(jobAnalyses)
	return saveErr
}

func (store *Store) SaveJobsAndReturn(jobAnalyses []domain.JobAnalysis) ([]domain.JobAnalysis, error) {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	existingJobs, listErr := store.listJobsLocked()
	if listErr != nil {
		return nil, fmt.Errorf("读取岗位列表失败: %w", listErr)
	}

	savedJobs := make([]domain.JobAnalysis, 0, len(jobAnalyses))
	for _, jobAnalysis := range jobAnalyses {
		savedJob, saveErr := store.upsertJobLocked(jobAnalysis, &existingJobs)
		if saveErr != nil {
			return nil, saveErr
		}
		savedJobs = append(savedJobs, savedJob)
	}
	if trimErr := store.trimJobsLocked(existingJobs); trimErr != nil {
		return nil, trimErr
	}
	return savedJobs, nil
}

func (store *Store) ListJobs() []domain.JobAnalysis {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	jobs, listErr := store.listJobsLocked()
	panicOnReadError("读取岗位列表失败", listErr)
	sort.SliceStable(jobs, func(leftIndex int, rightIndex int) bool {
		return jobs[leftIndex].CreatedAt.After(jobs[rightIndex].CreatedAt)
	})
	return jobs
}

func (store *Store) GetJob(jobID string) (domain.JobAnalysis, bool) {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	jobAnalysis, exists, getErr := getRecordLocked[domain.JobAnalysis](store.handle.database, keyJobPrefix+jobID)
	panicOnReadError("读取岗位失败", getErr)
	return jobAnalysis, exists
}

func (store *Store) SaveQueueItems(queueItems []domain.DeliveryQueueItem) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	existingItems, listErr := store.listQueueItemsLocked()
	if listErr != nil {
		return fmt.Errorf("读取投递队列失败: %w", listErr)
	}

	for _, queueItem := range queueItems {
		if saveErr := store.upsertQueueItemLocked(queueItem, &existingItems); saveErr != nil {
			return saveErr
		}
	}
	return store.trimQueueItemsLocked(existingItems)
}

func (store *Store) SaveDeliveryStrategy(deliveryStrategy domain.DeliveryStrategy) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	if saveErr := setRecordLocked(store.handle.database, keyDeliveryStrategy, deliveryStrategy); saveErr != nil {
		return fmt.Errorf("保存投递策略失败: %w", saveErr)
	}
	return nil
}

func (store *Store) GetDeliveryStrategy() domain.DeliveryStrategy {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	deliveryStrategy, exists, getErr := getRecordLocked[domain.DeliveryStrategy](store.handle.database, keyDeliveryStrategy)
	panicOnReadError("读取投递策略失败", getErr)
	if !exists || deliveryStrategy.MinMatchScore == 0 {
		return domain.DefaultDeliveryStrategy()
	}
	return deliveryStrategy
}

func (store *Store) SaveAutomationControl(automationControl domain.AutomationControl) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	if saveErr := setRecordLocked(store.handle.database, keyAutomationControl, automationControl); saveErr != nil {
		return fmt.Errorf("保存自动化控制失败: %w", saveErr)
	}
	return nil
}

func (store *Store) GetAutomationControl() domain.AutomationControl {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	automationControl, _, getErr := getRecordLocked[domain.AutomationControl](store.handle.database, keyAutomationControl)
	panicOnReadError("读取自动化控制失败", getErr)
	return automationControl
}

func (store *Store) SaveAutomationStatus(automationStatus domain.AutomationStatus) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	if automationStatus.Errors == nil {
		automationStatus.Errors = make([]string, 0)
	}
	if len(automationStatus.Errors) > 20 {
		automationStatus.Errors = append([]string(nil), automationStatus.Errors[len(automationStatus.Errors)-20:]...)
	}
	if saveErr := setRecordLocked(store.handle.database, keyAutomationStatus, automationStatus); saveErr != nil {
		return fmt.Errorf("保存自动化状态失败: %w", saveErr)
	}
	return nil
}

func (store *Store) GetAutomationStatus() domain.AutomationStatus {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	automationStatus, exists, getErr := getRecordLocked[domain.AutomationStatus](store.handle.database, keyAutomationStatus)
	panicOnReadError("读取自动化状态失败", getErr)
	if !exists || automationStatus.Errors == nil {
		automationStatus.Errors = make([]string, 0)
	}
	return automationStatus
}

func (store *Store) SaveAIReplySettings(settings domain.AIReplySettings) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	if saveErr := setRecordLocked(store.handle.database, keyAIReplySettings, settings); saveErr != nil {
		return fmt.Errorf("保存 AI 回复设置失败: %w", saveErr)
	}
	return nil
}

func (store *Store) GetAIReplySettings() domain.AIReplySettings {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	settings, _, getErr := getRecordLocked[domain.AIReplySettings](store.handle.database, keyAIReplySettings)
	panicOnReadError("读取 AI 回复设置失败", getErr)
	return settings
}

func (store *Store) ListQueueItems() []domain.DeliveryQueueItem {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	queueItems, listErr := store.listQueueItemsLocked()
	panicOnReadError("读取投递队列失败", listErr)
	return queueItems
}

func (store *Store) GetQueueItem(queueItemID string) (domain.DeliveryQueueItem, bool) {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	queueItem, exists, getErr := getRecordLocked[domain.DeliveryQueueItem](store.handle.database, keyQueueItemPrefix+queueItemID)
	panicOnReadError("读取投递队列项失败", getErr)
	return queueItem, exists
}

func (store *Store) UpdateQueueItem(queueItem domain.DeliveryQueueItem) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	if strings.TrimSpace(queueItem.ID) == "" {
		return fmt.Errorf("投递队列项 ID 不能为空")
	}
	if _, exists, getErr := getRecordLocked[domain.DeliveryQueueItem](store.handle.database, keyQueueItemPrefix+queueItem.ID); getErr != nil {
		return fmt.Errorf("读取投递队列项失败: %w", getErr)
	} else if !exists {
		return fmt.Errorf("投递队列项不存在")
	}

	queueItem = compactQueueItem(queueItem)
	if saveErr := setRecordLocked(store.handle.database, keyQueueItemPrefix+queueItem.ID, queueItem); saveErr != nil {
		return fmt.Errorf("更新投递队列项失败: %w", saveErr)
	}
	return nil
}

func (store *Store) SaveFeedback(feedbackRecord domain.FeedbackRecord) error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	feedbackRecord.ID = normalizeRecordID(feedbackRecord.ID, feedbackRecord.JobID+feedbackRecord.Status+feedbackRecord.CreatedAt.String(), generatedFeedbackPrefix)
	if saveErr := setRecordLocked(store.handle.database, keyFeedbackPrefix+feedbackRecord.ID, feedbackRecord); saveErr != nil {
		return fmt.Errorf("保存反馈记录失败: %w", saveErr)
	}

	feedbacks, listErr := store.listFeedbacksLocked()
	if listErr != nil {
		return fmt.Errorf("读取反馈记录失败: %w", listErr)
	}
	return store.trimFeedbacksLocked(feedbacks)
}

func (store *Store) ListFeedbacks() []domain.FeedbackRecord {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	feedbacks, listErr := store.listFeedbacksLocked()
	panicOnReadError("读取反馈记录失败", listErr)
	return feedbacks
}

func (store *Store) Stats() domain.DashboardStats {
	store.handle.mutex.RLock()
	defer store.handle.mutex.RUnlock()

	projects, projectErr := store.listProjectsLocked()
	panicOnReadError("读取项目统计失败", projectErr)
	resumes, resumeErr := store.listResumesLocked()
	panicOnReadError("读取简历统计失败", resumeErr)
	jobs, jobErr := store.listJobsLocked()
	panicOnReadError("读取岗位统计失败", jobErr)
	queueItems, queueErr := store.listQueueItemsLocked()
	panicOnReadError("读取投递队列统计失败", queueErr)
	feedbacks, feedbackErr := store.listFeedbacksLocked()
	panicOnReadError("读取反馈统计失败", feedbackErr)

	statusCounts := make(map[string]int)
	for _, feedbackRecord := range feedbacks {
		statusCounts[feedbackRecord.Status]++
	}
	queueStatusCounts := make(map[string]int)
	for _, queueItem := range queueItems {
		queueStatusCounts[queueItem.Status]++
	}

	return domain.DashboardStats{
		ProjectCount:  len(projects),
		ResumeCount:   len(resumes),
		JobCount:      len(jobs),
		QueueCount:    len(queueItems),
		QueueStatuses: queueStatusCounts,
		FeedbackCount: len(feedbacks),
		StatusCounts:  statusCounts,
	}
}

func openSharedLevelDatabase(dbPath string) (*sharedLevelDatabase, error) {
	sharedLevelDatabases.mutex.Lock()
	defer sharedLevelDatabases.mutex.Unlock()

	if existingHandle := sharedLevelDatabases.byPath[dbPath]; existingHandle != nil {
		existingHandle.refs++
		return existingHandle, nil
	}

	database, openErr := leveldb.OpenFile(dbPath, nil)
	if openErr != nil {
		return nil, fmt.Errorf("打开 LevelDB 数据库失败: %w", openErr)
	}

	handle := &sharedLevelDatabase{
		database: database,
		refs:     1,
	}
	sharedLevelDatabases.byPath[dbPath] = handle
	return handle, nil
}

func (store *Store) bootstrap() error {
	store.handle.mutex.Lock()
	defer store.handle.mutex.Unlock()

	empty, emptyErr := isDatabaseEmptyLocked(store.handle.database)
	if emptyErr != nil {
		return fmt.Errorf("检查数据存储状态失败: %w", emptyErr)
	}
	if empty {
		legacyData, readLegacy, legacyErr := store.readLegacyData()
		if legacyErr != nil {
			return legacyErr
		}
		if !readLegacy {
			legacyData = defaultAppData()
		}
		applyAppDataStorageLimits(&legacyData)
		if saveErr := store.saveAppDataLocked(legacyData); saveErr != nil {
			return fmt.Errorf("初始化 LevelDB 数据失败: %w", saveErr)
		}
	}

	return store.ensureDefaultRecordsLocked()
}

func (store *Store) readLegacyData() (appData, bool, error) {
	data := defaultAppData()
	fileContent, readErr := os.ReadFile(store.filePath)
	if errors.Is(readErr, os.ErrNotExist) {
		return data, false, nil
	}
	if readErr != nil {
		return data, false, fmt.Errorf("读取旧数据文件失败: %w", readErr)
	}
	if len(fileContent) == 0 {
		return data, false, nil
	}
	if decodeErr := json.Unmarshal(fileContent, &data); decodeErr != nil {
		return data, false, fmt.Errorf("解析旧数据文件失败: %w", decodeErr)
	}
	ensureAppData(&data)
	return data, true, nil
}

func (store *Store) saveAppDataLocked(data appData) error {
	ensureAppData(&data)
	applyAppDataStorageLimits(&data)

	existingProjects := make([]domain.ProjectSummary, 0, len(data.Projects))
	for _, projectSummary := range data.Projects {
		if saveErr := store.upsertProjectLocked(projectSummary, &existingProjects); saveErr != nil {
			return saveErr
		}
	}

	existingJobs := make([]domain.JobAnalysis, 0, len(data.Jobs))
	for _, jobAnalysis := range data.Jobs {
		if _, saveErr := store.upsertJobLocked(jobAnalysis, &existingJobs); saveErr != nil {
			return saveErr
		}
	}

	existingQueueItems := make([]domain.DeliveryQueueItem, 0, len(data.QueueItems))
	for _, queueItem := range data.QueueItems {
		if saveErr := store.upsertQueueItemLocked(queueItem, &existingQueueItems); saveErr != nil {
			return saveErr
		}
	}

	for _, resumeVersion := range data.Resumes {
		resumeVersion.ID = normalizeRecordID(resumeVersion.ID, resumeVersion.Name+resumeVersion.CreatedAt.String(), generatedResumePrefix)
		if saveErr := setRecordLocked(store.handle.database, keyResumePrefix+resumeVersion.ID, resumeVersion); saveErr != nil {
			return fmt.Errorf("迁移简历失败: %w", saveErr)
		}
	}

	for _, feedbackRecord := range data.Feedbacks {
		feedbackRecord.ID = normalizeRecordID(feedbackRecord.ID, feedbackRecord.JobID+feedbackRecord.Status+feedbackRecord.CreatedAt.String(), generatedFeedbackPrefix)
		if saveErr := setRecordLocked(store.handle.database, keyFeedbackPrefix+feedbackRecord.ID, feedbackRecord); saveErr != nil {
			return fmt.Errorf("迁移反馈记录失败: %w", saveErr)
		}
	}

	if saveErr := setRecordLocked(store.handle.database, keyDeliveryStrategy, data.DeliveryStrategy); saveErr != nil {
		return fmt.Errorf("迁移投递策略失败: %w", saveErr)
	}
	if saveErr := setRecordLocked(store.handle.database, keyAutomationControl, data.AutomationControl); saveErr != nil {
		return fmt.Errorf("迁移自动化控制失败: %w", saveErr)
	}
	if saveErr := setRecordLocked(store.handle.database, keyAutomationStatus, data.AutomationStatus); saveErr != nil {
		return fmt.Errorf("迁移自动化状态失败: %w", saveErr)
	}
	if data.AIReplySettings.Provider != "" || data.AIReplySettings.FallbackMode != "" || data.AIReplySettings.DeepSeekAPIKey != "" || data.AIReplySettings.ZhipuAPIKey != "" {
		if saveErr := setRecordLocked(store.handle.database, keyAIReplySettings, data.AIReplySettings); saveErr != nil {
			return fmt.Errorf("迁移 AI 回复设置失败: %w", saveErr)
		}
	}
	return nil
}

func (store *Store) ensureDefaultRecordsLocked() error {
	deliveryStrategy, exists, strategyErr := getRecordLocked[domain.DeliveryStrategy](store.handle.database, keyDeliveryStrategy)
	if strategyErr != nil {
		return fmt.Errorf("读取投递策略失败: %w", strategyErr)
	}
	if !exists || deliveryStrategy.MinMatchScore == 0 {
		if saveErr := setRecordLocked(store.handle.database, keyDeliveryStrategy, domain.DefaultDeliveryStrategy()); saveErr != nil {
			return fmt.Errorf("写入默认投递策略失败: %w", saveErr)
		}
	}

	automationStatus, exists, statusErr := getRecordLocked[domain.AutomationStatus](store.handle.database, keyAutomationStatus)
	if statusErr != nil {
		return fmt.Errorf("读取自动化状态失败: %w", statusErr)
	}
	if !exists || automationStatus.Errors == nil {
		automationStatus.Errors = make([]string, 0)
		if saveErr := setRecordLocked(store.handle.database, keyAutomationStatus, automationStatus); saveErr != nil {
			return fmt.Errorf("写入默认自动化状态失败: %w", saveErr)
		}
	}
	return nil
}

func (store *Store) upsertProjectLocked(projectSummary domain.ProjectSummary, existingProjects *[]domain.ProjectSummary) error {
	incomingID := strings.TrimSpace(projectSummary.ID)
	for projectIndex, existingProject := range *existingProjects {
		if existingProject.Path == projectSummary.Path && projectSummary.Path != "" {
			if incomingID == "" {
				projectSummary.ID = existingProject.ID
			} else {
				projectSummary.ID = incomingID
			}
			if existingProject.ID != projectSummary.ID {
				if deleteErr := deleteRecordLocked(store.handle.database, keyProjectPrefix+existingProject.ID); deleteErr != nil {
					return fmt.Errorf("删除旧项目记录失败: %w", deleteErr)
				}
			}
			(*existingProjects)[projectIndex] = projectSummary
			return setRecordLocked(store.handle.database, keyProjectPrefix+projectSummary.ID, projectSummary)
		}
	}

	projectSummary.ID = normalizeRecordID(incomingID, projectSummary.Path+projectSummary.Name, generatedProjectPrefix)
	*existingProjects = append(*existingProjects, projectSummary)
	if saveErr := setRecordLocked(store.handle.database, keyProjectPrefix+projectSummary.ID, projectSummary); saveErr != nil {
		return fmt.Errorf("保存项目失败: %w", saveErr)
	}
	return nil
}

func (store *Store) upsertJobLocked(jobAnalysis domain.JobAnalysis, existingJobs *[]domain.JobAnalysis) (domain.JobAnalysis, error) {
	jobAnalysis = compactJobAnalysis(jobAnalysis)
	for jobIndex, existingJob := range *existingJobs {
		if sameJobSource(existingJob, jobAnalysis) {
			jobAnalysis.ID = existingJob.ID
			jobAnalysis.CreatedAt = existingJob.CreatedAt
			(*existingJobs)[jobIndex] = jobAnalysis
			if saveErr := setRecordLocked(store.handle.database, keyJobPrefix+jobAnalysis.ID, jobAnalysis); saveErr != nil {
				return domain.JobAnalysis{}, fmt.Errorf("更新岗位失败: %w", saveErr)
			}
			return jobAnalysis, nil
		}
	}

	jobAnalysis.ID = normalizeRecordID(jobAnalysis.ID, jobAnalysis.URL+jobAnalysis.Title+jobAnalysis.Company+jobAnalysis.Description, generatedJobPrefix)
	*existingJobs = append(*existingJobs, jobAnalysis)
	if saveErr := setRecordLocked(store.handle.database, keyJobPrefix+jobAnalysis.ID, jobAnalysis); saveErr != nil {
		return domain.JobAnalysis{}, fmt.Errorf("保存岗位失败: %w", saveErr)
	}
	return jobAnalysis, nil
}

func (store *Store) upsertQueueItemLocked(queueItem domain.DeliveryQueueItem, existingItems *[]domain.DeliveryQueueItem) error {
	queueItem = compactQueueItem(queueItem)
	for itemIndex, existingItem := range *existingItems {
		if sameQueueSource(existingItem, queueItem) {
			queueItem.ID = existingItem.ID
			queueItem.CreatedAt = existingItem.CreatedAt
			if existingItem.ResumeID != "" {
				queueItem.ResumeID = existingItem.ResumeID
			}
			if existingItem.OpeningDraft != "" {
				queueItem.OpeningDraft = existingItem.OpeningDraft
			}
			if existingItem.Status != "" && existingItem.Status != "queued" {
				queueItem.Status = existingItem.Status
			}
			(*existingItems)[itemIndex] = queueItem
			if saveErr := setRecordLocked(store.handle.database, keyQueueItemPrefix+queueItem.ID, queueItem); saveErr != nil {
				return fmt.Errorf("更新投递队列失败: %w", saveErr)
			}
			return nil
		}
	}

	queueItem.ID = normalizeRecordID(queueItem.ID, queueItem.URL+queueItem.Title+queueItem.Company, generatedQueuePrefix)
	*existingItems = append(*existingItems, queueItem)
	if saveErr := setRecordLocked(store.handle.database, keyQueueItemPrefix+queueItem.ID, queueItem); saveErr != nil {
		return fmt.Errorf("保存投递队列失败: %w", saveErr)
	}
	return nil
}

func (store *Store) trimJobsLocked(jobs []domain.JobAnalysis) error {
	keptJobs := trimJobs(jobs, maxStoredJobs)
	if len(keptJobs) == len(jobs) {
		return nil
	}
	keepIDs := make(map[string]struct{}, len(keptJobs))
	for _, jobAnalysis := range keptJobs {
		keepIDs[jobAnalysis.ID] = struct{}{}
	}
	for _, jobAnalysis := range jobs {
		if _, keep := keepIDs[jobAnalysis.ID]; keep {
			continue
		}
		if deleteErr := deleteRecordLocked(store.handle.database, keyJobPrefix+jobAnalysis.ID); deleteErr != nil {
			return fmt.Errorf("裁剪岗位记录失败: %w", deleteErr)
		}
	}
	return nil
}

func (store *Store) trimQueueItemsLocked(queueItems []domain.DeliveryQueueItem) error {
	keptItems := trimQueueItems(queueItems, maxStoredQueueItems)
	if len(keptItems) == len(queueItems) {
		return nil
	}
	keepIDs := make(map[string]struct{}, len(keptItems))
	for _, queueItem := range keptItems {
		keepIDs[queueItem.ID] = struct{}{}
	}
	for _, queueItem := range queueItems {
		if _, keep := keepIDs[queueItem.ID]; keep {
			continue
		}
		if deleteErr := deleteRecordLocked(store.handle.database, keyQueueItemPrefix+queueItem.ID); deleteErr != nil {
			return fmt.Errorf("裁剪投递队列失败: %w", deleteErr)
		}
	}
	return nil
}

func (store *Store) trimFeedbacksLocked(feedbacks []domain.FeedbackRecord) error {
	keptFeedbacks := trimFeedbacks(feedbacks, maxStoredFeedbacks)
	if len(keptFeedbacks) == len(feedbacks) {
		return nil
	}
	keepIDs := make(map[string]struct{}, len(keptFeedbacks))
	for _, feedbackRecord := range keptFeedbacks {
		keepIDs[feedbackRecord.ID] = struct{}{}
	}
	for _, feedbackRecord := range feedbacks {
		if _, keep := keepIDs[feedbackRecord.ID]; keep {
			continue
		}
		if deleteErr := deleteRecordLocked(store.handle.database, keyFeedbackPrefix+feedbackRecord.ID); deleteErr != nil {
			return fmt.Errorf("裁剪反馈记录失败: %w", deleteErr)
		}
	}
	return nil
}

func (store *Store) listProjectsLocked() ([]domain.ProjectSummary, error) {
	projects, listErr := listRecordsLocked[domain.ProjectSummary](store.handle.database, keyProjectPrefix)
	if listErr != nil {
		return nil, listErr
	}
	sort.SliceStable(projects, func(leftIndex int, rightIndex int) bool {
		return projects[leftIndex].ScannedAt.Before(projects[rightIndex].ScannedAt)
	})
	return projects, nil
}

func (store *Store) listResumesLocked() ([]domain.ResumeVersion, error) {
	resumes, listErr := listRecordsLocked[domain.ResumeVersion](store.handle.database, keyResumePrefix)
	if listErr != nil {
		return nil, listErr
	}
	sort.SliceStable(resumes, func(leftIndex int, rightIndex int) bool {
		return resumes[leftIndex].CreatedAt.Before(resumes[rightIndex].CreatedAt)
	})
	return resumes, nil
}

func (store *Store) listJobsLocked() ([]domain.JobAnalysis, error) {
	jobs, listErr := listRecordsLocked[domain.JobAnalysis](store.handle.database, keyJobPrefix)
	if listErr != nil {
		return nil, listErr
	}
	sort.SliceStable(jobs, func(leftIndex int, rightIndex int) bool {
		return jobs[leftIndex].CreatedAt.Before(jobs[rightIndex].CreatedAt)
	})
	return jobs, nil
}

func (store *Store) listQueueItemsLocked() ([]domain.DeliveryQueueItem, error) {
	queueItems, listErr := listRecordsLocked[domain.DeliveryQueueItem](store.handle.database, keyQueueItemPrefix)
	if listErr != nil {
		return nil, listErr
	}
	sort.SliceStable(queueItems, func(leftIndex int, rightIndex int) bool {
		return queueItemSortTime(queueItems[leftIndex]).Before(queueItemSortTime(queueItems[rightIndex]))
	})
	return queueItems, nil
}

func (store *Store) listFeedbacksLocked() ([]domain.FeedbackRecord, error) {
	feedbacks, listErr := listRecordsLocked[domain.FeedbackRecord](store.handle.database, keyFeedbackPrefix)
	if listErr != nil {
		return nil, listErr
	}
	sort.SliceStable(feedbacks, func(leftIndex int, rightIndex int) bool {
		return feedbacks[leftIndex].CreatedAt.Before(feedbacks[rightIndex].CreatedAt)
	})
	return feedbacks, nil
}

func listRecordsLocked[T any](database *leveldb.DB, prefix string) ([]T, error) {
	iterator := database.NewIterator(util.BytesPrefix([]byte(prefix)), nil)
	records := make([]T, 0)
	for valid := iterator.First(); valid; valid = iterator.Next() {
		var record T
		if decodeErr := json.Unmarshal(iterator.Value(), &record); decodeErr != nil {
			iterator.Release()
			return nil, fmt.Errorf("解析记录失败: %w", decodeErr)
		}
		records = append(records, record)
	}
	if iteratorErr := iterator.Error(); iteratorErr != nil {
		iterator.Release()
		return nil, fmt.Errorf("遍历记录失败: %w", iteratorErr)
	}
	iterator.Release()
	return records, nil
}

func getRecordLocked[T any](database *leveldb.DB, key string) (T, bool, error) {
	var record T
	value, getErr := database.Get([]byte(key), nil)
	if errors.Is(getErr, leveldb.ErrNotFound) {
		return record, false, nil
	}
	if getErr != nil {
		return record, false, fmt.Errorf("读取记录失败: %w", getErr)
	}

	if decodeErr := json.Unmarshal(value, &record); decodeErr != nil {
		return record, false, fmt.Errorf("解析记录失败: %w", decodeErr)
	}
	return record, true, nil
}

func setRecordLocked(database *leveldb.DB, key string, value any) error {
	encodedValue, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return fmt.Errorf("编码记录失败: %w", marshalErr)
	}
	if setErr := database.Put([]byte(key), encodedValue, nil); setErr != nil {
		return fmt.Errorf("写入记录失败: %w", setErr)
	}
	return nil
}

func deleteRecordLocked(database *leveldb.DB, key string) error {
	if deleteErr := database.Delete([]byte(key), nil); deleteErr != nil {
		return fmt.Errorf("删除记录失败: %w", deleteErr)
	}
	return nil
}

func isDatabaseEmptyLocked(database *leveldb.DB) (bool, error) {
	iterator := database.NewIterator(nil, nil)
	empty := !iterator.First()
	if iteratorErr := iterator.Error(); iteratorErr != nil {
		iterator.Release()
		return false, fmt.Errorf("遍历数据库失败: %w", iteratorErr)
	}
	iterator.Release()
	return empty, nil
}

func normalizeRecordID(recordID string, fallbackSeed string, prefix string) string {
	cleanID := strings.TrimSpace(recordID)
	if cleanID != "" {
		return cleanID
	}

	seed := strings.TrimSpace(fallbackSeed)
	if seed == "" {
		seed = fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	digest := sha1.Sum([]byte(seed))
	return prefix + "_" + hex.EncodeToString(digest[:8])
}

func defaultAppData() appData {
	return appData{
		Projects:         make([]domain.ProjectSummary, 0),
		Resumes:          make([]domain.ResumeVersion, 0),
		Jobs:             make([]domain.JobAnalysis, 0),
		QueueItems:       make([]domain.DeliveryQueueItem, 0),
		Feedbacks:        make([]domain.FeedbackRecord, 0),
		DeliveryStrategy: domain.DefaultDeliveryStrategy(),
		AutomationStatus: domain.AutomationStatus{
			Errors: make([]string, 0),
		},
	}
}

func ensureAppData(data *appData) {
	if data.Projects == nil {
		data.Projects = make([]domain.ProjectSummary, 0)
	}
	if data.Resumes == nil {
		data.Resumes = make([]domain.ResumeVersion, 0)
	}
	if data.Jobs == nil {
		data.Jobs = make([]domain.JobAnalysis, 0)
	}
	if data.QueueItems == nil {
		data.QueueItems = make([]domain.DeliveryQueueItem, 0)
	}
	if data.Feedbacks == nil {
		data.Feedbacks = make([]domain.FeedbackRecord, 0)
	}
	if data.DeliveryStrategy.MinMatchScore == 0 {
		data.DeliveryStrategy = domain.DefaultDeliveryStrategy()
	}
	if data.AutomationStatus.Errors == nil {
		data.AutomationStatus.Errors = make([]string, 0)
	}
}

func applyAppDataStorageLimits(data *appData) {
	ensureAppData(data)
	for index := range data.Jobs {
		data.Jobs[index] = compactJobAnalysis(data.Jobs[index])
	}
	for index := range data.QueueItems {
		data.QueueItems[index] = compactQueueItem(data.QueueItems[index])
	}
	if len(data.AutomationStatus.Errors) > 20 {
		data.AutomationStatus.Errors = append([]string(nil), data.AutomationStatus.Errors[len(data.AutomationStatus.Errors)-20:]...)
	}

	data.Jobs = trimJobs(data.Jobs, maxStoredJobs)
	data.QueueItems = trimQueueItems(data.QueueItems, maxStoredQueueItems)
	data.Feedbacks = trimFeedbacks(data.Feedbacks, maxStoredFeedbacks)
}

func sameQueueSource(leftItem domain.DeliveryQueueItem, rightItem domain.DeliveryQueueItem) bool {
	if leftItem.URL != "" && rightItem.URL != "" {
		return leftItem.URL == rightItem.URL
	}
	return leftItem.Title == rightItem.Title && leftItem.Company == rightItem.Company
}

func sameJobSource(leftJob domain.JobAnalysis, rightJob domain.JobAnalysis) bool {
	if leftJob.URL != "" && rightJob.URL != "" {
		return leftJob.URL == rightJob.URL
	}
	return leftJob.Title == rightJob.Title && leftJob.Company == rightJob.Company && leftJob.Description == rightJob.Description
}

func compactJobAnalysis(jobAnalysis domain.JobAnalysis) domain.JobAnalysis {
	jobAnalysis.Title = trimRunes(jobAnalysis.Title, maxTextFieldRunes)
	jobAnalysis.Company = trimRunes(jobAnalysis.Company, maxTextFieldRunes)
	jobAnalysis.Location = trimRunes(jobAnalysis.Location, maxTextFieldRunes)
	jobAnalysis.Salary = trimRunes(jobAnalysis.Salary, maxTextFieldRunes)
	jobAnalysis.URL = trimRunes(jobAnalysis.URL, maxTextFieldRunes)
	jobAnalysis.Description = trimRunes(jobAnalysis.Description, maxJobDescriptionRunes)
	jobAnalysis.Recommendation = trimRunes(jobAnalysis.Recommendation, maxTextFieldRunes)
	jobAnalysis.Keywords = trimStringSlice(jobAnalysis.Keywords, maxJobRequirementItems, 80)
	jobAnalysis.HardRequirements = trimStringSlice(jobAnalysis.HardRequirements, maxJobRequirementItems, 180)
	jobAnalysis.BonusItems = trimStringSlice(jobAnalysis.BonusItems, maxJobRequirementItems, 180)
	jobAnalysis.MissingSkills = trimStringSlice(jobAnalysis.MissingSkills, maxJobRequirementItems, 80)
	jobAnalysis.Risks = trimStringSlice(jobAnalysis.Risks, maxJobRequirementItems, 180)
	return jobAnalysis
}

func compactQueueItem(queueItem domain.DeliveryQueueItem) domain.DeliveryQueueItem {
	queueItem.Title = trimRunes(queueItem.Title, maxTextFieldRunes)
	queueItem.Company = trimRunes(queueItem.Company, maxTextFieldRunes)
	queueItem.Location = trimRunes(queueItem.Location, maxTextFieldRunes)
	queueItem.Salary = trimRunes(queueItem.Salary, maxTextFieldRunes)
	queueItem.URL = trimRunes(queueItem.URL, maxTextFieldRunes)
	queueItem.Recommendation = trimRunes(queueItem.Recommendation, maxTextFieldRunes)
	queueItem.OpeningDraft = trimRunes(queueItem.OpeningDraft, maxTextFieldRunes)
	queueItem.Keywords = trimStringSlice(queueItem.Keywords, maxJobRequirementItems, 80)
	queueItem.FilterReasons = trimStringSlice(queueItem.FilterReasons, maxQueueFilterReasonItems, 160)
	return queueItem
}

func trimJobs(jobs []domain.JobAnalysis, limit int) []domain.JobAnalysis {
	if len(jobs) <= limit {
		return jobs
	}
	sort.SliceStable(jobs, func(leftIndex int, rightIndex int) bool {
		return jobs[leftIndex].CreatedAt.After(jobs[rightIndex].CreatedAt)
	})
	return append([]domain.JobAnalysis(nil), jobs[:limit]...)
}

func trimQueueItems(queueItems []domain.DeliveryQueueItem, limit int) []domain.DeliveryQueueItem {
	if len(queueItems) <= limit {
		return queueItems
	}
	sort.SliceStable(queueItems, func(leftIndex int, rightIndex int) bool {
		return queueItemSortTime(queueItems[leftIndex]).After(queueItemSortTime(queueItems[rightIndex]))
	})
	return append([]domain.DeliveryQueueItem(nil), queueItems[:limit]...)
}

func trimFeedbacks(feedbacks []domain.FeedbackRecord, limit int) []domain.FeedbackRecord {
	if len(feedbacks) <= limit {
		return feedbacks
	}
	sort.SliceStable(feedbacks, func(leftIndex int, rightIndex int) bool {
		return feedbacks[leftIndex].CreatedAt.After(feedbacks[rightIndex].CreatedAt)
	})
	return append([]domain.FeedbackRecord(nil), feedbacks[:limit]...)
}

func queueItemSortTime(queueItem domain.DeliveryQueueItem) time.Time {
	if !queueItem.UpdatedAt.IsZero() {
		return queueItem.UpdatedAt
	}
	return queueItem.CreatedAt
}

func trimStringSlice(values []string, maxItems int, maxRunes int) []string {
	if len(values) == 0 {
		return values
	}
	limit := len(values)
	if maxItems > 0 && limit > maxItems {
		limit = maxItems
	}
	result := make([]string, 0, limit)
	for _, value := range values[:limit] {
		cleaned := trimRunes(value, maxRunes)
		if cleaned != "" {
			result = append(result, cleaned)
		}
	}
	return result
}

func trimRunes(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func panicOnReadError(message string, err error) {
	if err != nil {
		panic(fmt.Errorf("%s: %w", message, err))
	}
}

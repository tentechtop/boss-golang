package domain

import "time"

type CandidateProfile struct {
	Name            string   `json:"name"`
	TargetRole      string   `json:"targetRole"`
	Email           string   `json:"email"`
	Phone           string   `json:"phone"`
	Location        string   `json:"location"`
	Education       string   `json:"education"`
	YearsExperience string   `json:"yearsExperience"`
	Skills          []string `json:"skills"`
}

type ProjectSummary struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Path           string    `json:"path"`
	TechStack      []string  `json:"techStack"`
	BusinessDomain string    `json:"businessDomain"`
	CoreModules    []string  `json:"coreModules"`
	Highlights     []string  `json:"highlights"`
	EvidenceFiles  []string  `json:"evidenceFiles"`
	FileCount      int       `json:"fileCount"`
	ScannedAt      time.Time `json:"scannedAt"`
}

type JobAnalysis struct {
	ID               string    `json:"id"`
	Title            string    `json:"title"`
	Company          string    `json:"company"`
	Location         string    `json:"location"`
	Salary           string    `json:"salary"`
	URL              string    `json:"url"`
	Description      string    `json:"description"`
	Keywords         []string  `json:"keywords"`
	HardRequirements []string  `json:"hardRequirements"`
	BonusItems       []string  `json:"bonusItems"`
	MissingSkills    []string  `json:"missingSkills"`
	Risks            []string  `json:"risks"`
	MatchScore       int       `json:"matchScore"`
	Recommendation   string    `json:"recommendation"`
	CreatedAt        time.Time `json:"createdAt"`
}

type VisibleJob struct {
	ClientID    string `json:"clientId"`
	Title       string `json:"title"`
	Company     string `json:"company"`
	Location    string `json:"location"`
	Salary      string `json:"salary"`
	URL         string `json:"url"`
	Description string `json:"description"`
}

type VisibleJobAnalysis struct {
	ClientID      string      `json:"clientId"`
	Source        VisibleJob  `json:"source"`
	Analysis      JobAnalysis `json:"analysis"`
	HighMatch     bool        `json:"highMatch"`
	Eligible      bool        `json:"eligible"`
	HardBlocked   bool        `json:"hardBlocked"`
	FilterReasons []string    `json:"filterReasons"`
	QueueStatus   string      `json:"queueStatus"`
}

type DeliveryQueueItem struct {
	ID             string    `json:"id"`
	JobID          string    `json:"jobId"`
	ResumeID       string    `json:"resumeId"`
	Title          string    `json:"title"`
	Company        string    `json:"company"`
	Location       string    `json:"location"`
	Salary         string    `json:"salary"`
	URL            string    `json:"url"`
	MatchScore     int       `json:"matchScore"`
	Recommendation string    `json:"recommendation"`
	Keywords       []string  `json:"keywords"`
	FilterReasons  []string  `json:"filterReasons"`
	OpeningDraft   string    `json:"openingDraft"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type DeliveryStrategy struct {
	MinMatchScore              int      `json:"minMatchScore"`
	BatchPrepareLimit          int      `json:"batchPrepareLimit"`
	MinSalaryK                 int      `json:"minSalaryK"`
	MaxSalaryK                 int      `json:"maxSalaryK"`
	AllowUnknownSalary         bool     `json:"allowUnknownSalary"`
	DefaultChatMode            string   `json:"defaultChatMode"`
	IncludeTitleKeywords       []string `json:"includeTitleKeywords"`
	ExcludeTitleKeywords       []string `json:"excludeTitleKeywords"`
	IncludeCompanyKeywords     []string `json:"includeCompanyKeywords"`
	ExcludeCompanyKeywords     []string `json:"excludeCompanyKeywords"`
	IncludeDescriptionKeywords []string `json:"includeDescriptionKeywords"`
	ExcludeDescriptionKeywords []string `json:"excludeDescriptionKeywords"`
	GreetingPrompt             string   `json:"greetingPrompt"`
}

func DefaultDeliveryStrategy() DeliveryStrategy {
	return DeliveryStrategy{
		MinMatchScore:     1,
		BatchPrepareLimit: 20,
		MinSalaryK:        25,
		// 最高月薪留空时仅按最低月薪筛选，避免遗漏薪资更高但仍值得沟通的岗位。
		MaxSalaryK:         0,
		AllowUnknownSalary: false,
		DefaultChatMode:    "专业稳重",
		IncludeTitleKeywords: []string{
			"golang后端",
			"Go",
			"Golang",
			"Go后端",
			"Go 后端",
			"Go语言",
		},
	}
}

type DeliveryQueueStats struct {
	Total        int            `json:"total"`
	StatusCounts map[string]int `json:"statusCounts"`
	NextItemID   string         `json:"nextItemId"`
}

type AutomationControl struct {
	Enabled             bool      `json:"enabled"`
	ResumeID            string    `json:"resumeId"`
	Keyword             string    `json:"keyword"`
	City                string    `json:"city"`
	ChatMode            string    `json:"chatMode"`
	ScanIntervalMinutes int       `json:"scanIntervalMinutes"`
	MaxChatRounds       int       `json:"maxChatRounds"`
	MaxJobsPerScan      int       `json:"maxJobsPerScan"`
	MinMatchScore       int       `json:"minMatchScore"`
	Revision            int64     `json:"revision"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type AutomationStatus struct {
	BridgeConnected    bool      `json:"bridgeConnected"`
	ExtensionVersion   string    `json:"extensionVersion"`
	RuntimeID          string    `json:"runtimeId"`
	Surface            string    `json:"surface"`
	DesiredRevision    int64     `json:"desiredRevision"`
	AppliedRevision    int64     `json:"appliedRevision"`
	Enabled            bool      `json:"enabled"`
	Phase              string    `json:"phase"`
	CurrentQueueItemID string    `json:"currentQueueItemId"`
	CurrentJobID       string    `json:"currentJobId"`
	TotalProcessed     int       `json:"totalProcessed"`
	TotalChatted       int       `json:"totalChatted"`
	CurrentRound       int       `json:"currentRound"`
	LastScanAt         time.Time `json:"lastScanAt"`
	LastChatAt         time.Time `json:"lastChatAt"`
	LastSeenAt         time.Time `json:"lastSeenAt"`
	Errors             []string  `json:"errors"`
}

type AIReplySettings struct {
	Provider       string    `json:"provider"`
	FallbackMode   string    `json:"fallbackMode"`
	DeepSeekModel  string    `json:"deepSeekModel"`
	DeepSeekAPIKey string    `json:"deepSeekApiKey,omitempty"`
	ZhipuModel     string    `json:"zhipuModel"`
	ZhipuAPIKey    string    `json:"zhipuApiKey,omitempty"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type ResumeVersion struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	SourceFileName string           `json:"sourceFileName,omitempty"`
	Profile        CandidateProfile `json:"profile"`
	ProjectIDs     []string         `json:"projectIds"`
	TargetJobID    string           `json:"targetJobId"`
	Markdown       string           `json:"markdown"`
	HTML           string           `json:"html"`
	CreatedAt      time.Time        `json:"createdAt"`
}

type Message struct {
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

type ChatSuggestion struct {
	Mode               string   `json:"mode"`
	RecommendedReply   string   `json:"recommendedReply"`
	AlternativeReplies []string `json:"alternativeReplies"`
	Reasons            []string `json:"reasons"`
	NeedUserCheck      []string `json:"needUserCheck"`
	Generator          string   `json:"generator"`
	// BOSS 操作指令：当检测到 HR 索要简历/微信/电话等系统消息时，通知前端自动执行 BOSS 操作
	BossOperation string `json:"bossOperation,omitempty"` // "sendResume" | "acceptAttachmentResume" | "acceptWechat" | "acceptPhone"
}

// BOSS 操作类型常量
const (
	BossOpSendResume             = "sendResume"
	BossOpAcceptAttachmentResume = "acceptAttachmentResume"
	BossOpAcceptWechat           = "acceptWechat"
	BossOpAcceptPhone            = "acceptPhone"
)

type FeedbackRecord struct {
	ID        string    `json:"id"`
	JobID     string    `json:"jobId"`
	Company   string    `json:"company"`
	ResumeID  string    `json:"resumeId"`
	Status    string    `json:"status"`
	Message   string    `json:"message"`
	Notes     string    `json:"notes"`
	CreatedAt time.Time `json:"createdAt"`
}

type DashboardStats struct {
	ProjectCount  int            `json:"projectCount"`
	ResumeCount   int            `json:"resumeCount"`
	JobCount      int            `json:"jobCount"`
	QueueCount    int            `json:"queueCount"`
	QueueStatuses map[string]int `json:"queueStatuses"`
	FeedbackCount int            `json:"feedbackCount"`
	StatusCounts  map[string]int `json:"statusCounts"`
}

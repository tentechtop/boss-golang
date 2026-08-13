package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"boss-job-assistant/internal/chat"
	"boss-job-assistant/internal/database"
	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/job"
	"boss-job-assistant/internal/project"
	"boss-job-assistant/internal/resume"
	"boss-job-assistant/internal/utils"
)

const (
	defaultHighMatchScore    = 75
	maxVisibleJobCount       = 30
	maxBatchPrepareCount     = 50
	maxStrategyKeywordCount  = 20
	maxStrategyKeywordLength = 40
	maxStrategySalaryK       = 300
	defaultTargetRole        = "golang后端"
	fixedMinSalaryK          = 25
	similarSalaryUpperGapK   = 10
	fixedMinMatchScore       = 1
	fixedTargetCity          = "深圳市"
	queueStatusQueued        = "queued"
	queueStatusPrepared      = "prepared"
	queueStatusOpened        = "opened"
	queueStatusFilled        = "filled"
	queueStatusDelivered     = "delivered"
	queueStatusSkipped       = "skipped"
	queueStatusRejected      = "rejected"
	fillTaskTTL              = 10 * time.Minute
)

var hunterTitleBlockKeywords = []string{"猎头", "代招", "招聘顾问", "人事顾问", "RPO", "寻访"}

var hunterCompanyBlockKeywords = []string{"猎头", "人力资源", "人才服务", "人力资源服务", "企业管理咨询", "招聘顾问", "RPO"}

var hunterDescriptionBlockKeywords = []string{"猎头", "代招", "招聘顾问", "人才寻访", "人力资源服务", "接受委托招聘", "代客户招聘", "为客户招聘", "RPO"}

var monthlyKSalaryPattern = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(?:-|~|—|至)\s*(\d+(?:\.\d+)?)\s*k`)

var singleMonthlyKSalaryPattern = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*k`)

var monthlyWanSalaryPattern = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:-|~|—|至)\s*(\d+(?:\.\d+)?)\s*万`)

type salaryRangeK struct {
	MinK  int
	MaxK  int
	Known bool
}

type ServerConfig struct {
	Store                 *database.Store
	AIClient              ChatCompletionClient
	CodexClient           ChatCompletionClient
	DeepSeekAPIKey        string
	DefaultDeepSeekModel  string
	DeepSeekClientFactory ChatCompletionClientFactory
	ZhipuClient           ChatCompletionClient
	ZhipuAPIKey           string
	DefaultZhipuModel     string
	ZhipuClientFactory    ChatCompletionClientFactory
	StaticDir             string
	MaxRequestSize        int64
	Logger                *slog.Logger
}

type ChatCompletionClient interface {
	Configured() bool
	Complete(ctx context.Context, systemPrompt string, userPrompt string) (string, error)
}

type ChatCompletionClientFactory func(apiKey string, model string) ChatCompletionClient

type availabilityChecker interface {
	CheckAvailability(ctx context.Context) error
}

type Server struct {
	store                 *database.Store
	aiClient              ChatCompletionClient
	codexClient           ChatCompletionClient
	deepSeekAPIKey        string
	defaultDeepSeekModel  string
	deepSeekClientFactory ChatCompletionClientFactory
	zhipuClient           ChatCompletionClient
	zhipuAPIKey           string
	defaultZhipuModel     string
	zhipuClientFactory    ChatCompletionClientFactory
	staticDir             string
	maxRequestSize        int64
	logger                *slog.Logger
	fillTaskMutex         sync.Mutex
	fillTasks             map[string]deliveryFillTask
	browserLaunchMutex    sync.Mutex
	lastBrowserLaunchAt   time.Time
	browserLaunchFunc     func() error
}

func NewServer(config ServerConfig) *Server {
	server := &Server{
		store:                 config.Store,
		aiClient:              config.AIClient,
		codexClient:           config.CodexClient,
		deepSeekAPIKey:        strings.TrimSpace(config.DeepSeekAPIKey),
		defaultDeepSeekModel:  strings.TrimSpace(config.DefaultDeepSeekModel),
		deepSeekClientFactory: config.DeepSeekClientFactory,
		zhipuClient:           config.ZhipuClient,
		zhipuAPIKey:           strings.TrimSpace(config.ZhipuAPIKey),
		defaultZhipuModel:     strings.TrimSpace(config.DefaultZhipuModel),
		zhipuClientFactory:    config.ZhipuClientFactory,
		staticDir:             config.StaticDir,
		maxRequestSize:        config.MaxRequestSize,
		logger:                config.Logger,
		fillTasks:             make(map[string]deliveryFillTask),
	}
	server.browserLaunchFunc = server.startDedicatedBrowser
	return server
}

// 注册路由：集中声明 HTTP 边界，方便审查对外暴露能力。
func (server *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", server.handleHealth)
	mux.HandleFunc("GET /api/dashboard", server.handleDashboard)
	mux.HandleFunc("GET /api/projects", server.handleListProjects)
	mux.HandleFunc("POST /api/projects/scan", server.handleScanProjects)
	mux.HandleFunc("GET /api/resumes", server.handleListResumes)
	mux.HandleFunc("POST /api/resumes/import", server.handleImportResume)
	mux.HandleFunc("POST /api/resumes/import-file", server.handleImportResumeFile)
	mux.HandleFunc("POST /api/resumes/generate", server.handleGenerateResume)
	mux.HandleFunc("GET /api/resumes/", server.handleGetResume)
	mux.HandleFunc("GET /api/jobs", server.handleListJobs)
	mux.HandleFunc("POST /api/jobs/analyze", server.handleAnalyzeJob)
	mux.HandleFunc("POST /api/jobs/visible/analyze", server.handleAnalyzeVisibleJobs)
	mux.HandleFunc("POST /api/resumes/tailor", server.handleTailorResume)
	mux.HandleFunc("POST /api/chat/suggest", server.handleSuggestChat)
	mux.HandleFunc("POST /api/chat/sandbox/auto", server.handleSandboxAutoChat)
	mux.HandleFunc("POST /api/chat/auto/reply", server.handleAutoChatReply)
	mux.HandleFunc("POST /api/chat/auto/status", server.handleUpdateAutoChatStatus)
	mux.HandleFunc("GET /api/ai/reply-settings", server.handleGetAIReplySettings)
	mux.HandleFunc("POST /api/ai/reply-settings", server.handleSaveAIReplySettings)
	mux.HandleFunc("GET /api/automation/control", server.handleGetAutomationControl)
	mux.HandleFunc("POST /api/automation/control", server.handleSaveAutomationControl)
	mux.HandleFunc("GET /api/automation/status", server.handleGetAutomationStatus)
	mux.HandleFunc("POST /api/automation/status", server.handleSaveAutomationStatus)
	mux.HandleFunc("GET /api/extension/package", server.handleDownloadExtensionPackage)
	mux.HandleFunc("POST /api/extension/launch", server.handleLaunchExtensionBrowser)
	mux.HandleFunc("GET /api/delivery/strategy", server.handleGetDeliveryStrategy)
	mux.HandleFunc("POST /api/delivery/strategy", server.handleSaveDeliveryStrategy)
	mux.HandleFunc("GET /api/delivery/queue", server.handleListDeliveryQueue)
	mux.HandleFunc("POST /api/delivery/queue/add", server.handleAddDeliveryQueue)
	mux.HandleFunc("POST /api/delivery/queue/prepare", server.handlePrepareDeliveryQueue)
	mux.HandleFunc("POST /api/delivery/queue/prepare-all", server.handlePrepareAllDeliveryQueue)
	mux.HandleFunc("POST /api/delivery/queue/fill-request", server.handleRequestQueueFill)
	mux.HandleFunc("GET /api/delivery/fill-task", server.handleGetFillTask)
	mux.HandleFunc("POST /api/delivery/fill-task/complete", server.handleCompleteFillTask)
	mux.HandleFunc("POST /api/delivery/queue/status", server.handleUpdateDeliveryQueueStatus)
	mux.HandleFunc("GET /api/delivery/queue/next-auto", server.handleGetNextAutoQueueItem)
	mux.HandleFunc("POST /api/feedback", server.handleFeedback)
	mux.HandleFunc("GET /api/feedback", server.handleListFeedback)
	mux.Handle("/", http.FileServer(http.Dir(server.staticDir)))
	return server.withMiddleware(mux)
}

func (server *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(responseWriter http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			responseWriter.Header().Set("Access-Control-Allow-Origin", origin)
		}
		responseWriter.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		responseWriter.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		responseWriter.Header().Set("X-Content-Type-Options", "nosniff")
		responseWriter.Header().Set("Cache-Control", "no-store")

		if request.Method == http.MethodOptions {
			responseWriter.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(responseWriter, request)
	})
}

// 校验来源：限制浏览器跨域入口，降低本地接口被网页滥用风险。
func isAllowedOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	if strings.HasPrefix(origin, "chrome-extension://") {
		return true
	}
	if strings.HasPrefix(origin, "http://127.0.0.1:") {
		return true
	}
	if strings.HasPrefix(origin, "http://localhost:") {
		return true
	}
	return false
}

// 健康检查：暴露运行状态，避免排查时读取敏感配置。
func (server *Server) handleHealth(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"status":          "ok",
		"deepSeekEnabled": server.aiClient != nil && server.aiClient.Configured(),
		"zhipuEnabled":    server.zhipuClient != nil && server.zhipuClient.Configured(),
		"codexEnabled":    server.codexClient != nil && server.codexClient.Configured(),
		"serverTime":      time.Now(),
	})
}

func (server *Server) handleDashboard(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, server.store.Stats())
}

func (server *Server) handleListProjects(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{"projects": server.store.ListProjects()})
}

type scanProjectsRequest struct {
	Paths []string `json:"paths"`
}

func (server *Server) handleScanProjects(responseWriter http.ResponseWriter, request *http.Request) {
	var payload scanProjectsRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	projectSummaries, scanErr := project.ScanProjects(payload.Paths)
	if scanErr != nil {
		writeError(responseWriter, http.StatusBadRequest, scanErr)
		return
	}

	if saveErr := server.store.SaveProjects(projectSummaries); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	server.logger.Info("项目扫描完成", "count", len(projectSummaries))
	writeJSON(responseWriter, http.StatusOK, map[string]any{"projects": projectSummaries})
}

func (server *Server) handleListResumes(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{"resumes": server.store.ListResumes()})
}

type generateResumeRequest struct {
	Profile    domain.CandidateProfile `json:"profile"`
	ProjectIDs []string                `json:"projectIds"`
}

func (server *Server) handleGenerateResume(responseWriter http.ResponseWriter, request *http.Request) {
	var payload generateResumeRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	projects := server.store.GetProjectsByID(payload.ProjectIDs)
	resumeVersion, generateErr := resume.Generate(payload.Profile, projects, nil)
	if generateErr != nil {
		writeError(responseWriter, http.StatusBadRequest, generateErr)
		return
	}

	if saveErr := server.store.SaveResume(resumeVersion); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"resume": resumeVersion})
}

func (server *Server) handleGetResume(responseWriter http.ResponseWriter, request *http.Request) {
	resumeID := strings.TrimPrefix(request.URL.Path, "/api/resumes/")
	if resumeID == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("简历 ID 不能为空"))
		return
	}

	resumeVersion, exists := server.store.GetResume(resumeID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("简历不存在"))
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"resume": resumeVersion})
}

type analyzeJobRequest struct {
	Title           string   `json:"title"`
	Company         string   `json:"company"`
	Description     string   `json:"description"`
	CandidateSkills []string `json:"candidateSkills"`
}

func (server *Server) handleListJobs(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{"jobs": server.store.ListJobs()})
}

func (server *Server) handleAnalyzeJob(responseWriter http.ResponseWriter, request *http.Request) {
	var payload analyzeJobRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	jobAnalysis, analyzeErr := job.Analyze(payload.Description, payload.Title, payload.Company, payload.CandidateSkills)
	if analyzeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, analyzeErr)
		return
	}

	if saveErr := server.store.SaveJob(jobAnalysis); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"job":       jobAnalysis,
		"generator": "local_rule",
	})
}

type analyzeVisibleJobsRequest struct {
	Jobs            []domain.VisibleJob `json:"jobs"`
	CandidateSkills []string            `json:"candidateSkills"`
	MinScore        int                 `json:"minScore"`
}

func (server *Server) handleAnalyzeVisibleJobs(responseWriter http.ResponseWriter, request *http.Request) {
	var payload analyzeVisibleJobsRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	deliveryStrategy := server.resolveDeliveryStrategy(payload.MinScore)
	candidateSkills := server.resolveCandidateSkills(payload.CandidateSkills)
	visibleAnalyses, analyzeErr := analyzeVisibleJobs(payload.Jobs, candidateSkills, deliveryStrategy)
	if analyzeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, analyzeErr)
		return
	}
	if saveErr := server.saveVisibleJobAnalyses(visibleAnalyses); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"jobs":     visibleAnalyses,
		"strategy": deliveryStrategy,
	})
}

type tailorResumeRequest struct {
	Profile    domain.CandidateProfile `json:"profile"`
	ProjectIDs []string                `json:"projectIds"`
	JobID      string                  `json:"jobId"`
}

func (server *Server) handleTailorResume(responseWriter http.ResponseWriter, request *http.Request) {
	var payload tailorResumeRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	jobAnalysis, exists := server.store.GetJob(payload.JobID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("岗位分析不存在"))
		return
	}

	projects := server.store.GetProjectsByID(payload.ProjectIDs)
	resumeVersion, generateErr := resume.Generate(payload.Profile, projects, &jobAnalysis)
	if generateErr != nil {
		writeError(responseWriter, http.StatusBadRequest, generateErr)
		return
	}

	if saveErr := server.store.SaveResume(resumeVersion); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"resume": resumeVersion})
}

type suggestChatRequest struct {
	JobID    string           `json:"jobId"`
	ResumeID string           `json:"resumeId"`
	Messages []domain.Message `json:"messages"`
	Mode     string           `json:"mode"`
}

func (server *Server) handleSuggestChat(responseWriter http.ResponseWriter, request *http.Request) {
	var payload suggestChatRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	jobAnalysis, exists := server.store.GetJob(payload.JobID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("岗位分析不存在"))
		return
	}

	var resumePointer *domain.ResumeVersion
	if payload.ResumeID != "" {
		resumeVersion, resumeExists := server.store.GetResume(payload.ResumeID)
		if !resumeExists {
			writeError(responseWriter, http.StatusNotFound, fmt.Errorf("简历不存在"))
			return
		}
		resumePointer = &resumeVersion
	}

	suggestion, suggestErr := server.buildChatSuggestion(request, jobAnalysis, resumePointer, payload.Messages, payload.Mode)
	if suggestErr != nil {
		writeError(responseWriter, http.StatusBadGateway, suggestErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"suggestion": suggestion})
}

func (server *Server) buildChatSuggestion(request *http.Request, jobAnalysis domain.JobAnalysis, resumePointer *domain.ResumeVersion, messages []domain.Message, mode string) (domain.ChatSuggestion, error) {
	deliveryStrategy := normalizeDeliveryStrategy(server.store.GetDeliveryStrategy())
	if strings.TrimSpace(mode) == "" {
		mode = deliveryStrategy.DefaultChatMode
	}

	localSuggestion := chat.Suggest(jobAnalysis, resumePointer, messages, mode)
	systemPrompt := "你是求职沟通助手。你的任务是根据岗位JD、候选人简历和完整对话上下文，生成候选人的下一句回复。\n" +
		"最终目标：在不编造经历的前提下，把有效对话推进到简历审核、电话沟通或面试安排，而不是停留在礼貌闲聊。\n" +
		"核心规则：\n" +
		"1. 只能基于候选人简历中的真实经验和技能来回复，禁止编造任何项目、年限、薪资、指标\n" +
		"2. 必须同时使用岗位要求和简历事实：选择最相关的1到2个真实匹配点，不要罗列整份技术栈\n" +
		"3. 先逐项回答HR本轮发来的所有具体问题和要求，再用一句自然的话推动下一步，例如发送简历、电话沟通或约面试\n" +
		"4. 岗位大致匹配时明确表达意愿并争取面试；明显不匹配时说明主要求职方向并询问是否有相近岗位\n" +
		"5. 岗位薪资低于候选人目标时直接询问预算是否可谈，不假装接受；收到面试邀请时优先确认时间\n" +
		"6. 使用真实求职者在即时聊天里的口吻，真诚、尊重、有分寸，通常20到100字；HR多问时以完整回答为先\n" +
		"7. 对HR提供的信息、投入的时间或沟通机会自然表达感谢，并对贵司和岗位保持尊重；可结合语境使用“感谢您的回复”“感谢贵司提供沟通机会”等表达，但每条最多一次，不机械重复、不奉承、不卑微，也不要使用客服或公文腔\n" +
		"8. HR连续发来多条消息或一条消息中有多个、编号问题时，必须按顺序全部回答，不能遗漏或只回答最后一个；如需反问，一次只追问一个真正影响求职推进的问题\n" +
		"9. HR索要简历时礼貌感谢并简短确认，例如“感谢您的关注，简历刚发您了”，不要长篇介绍\n" +
		"10. 只输出可直接发送的回复内容，不要加任何前缀、后缀或解释"
	userPrompt := buildDeepSeekChatPrompt(jobAnalysis, resumePointer, messages, mode, deliveryStrategy)

	aiReplySettings := server.normalizedAIReplySettings()
	switch aiReplySettings.Provider {
	case aiReplyProviderCodex:
		codexStatus := server.codexAvailability(request.Context())
		if !codexStatus.Available {
			localSuggestion.Reasons = append([]string{codexStatus.Message + "，已使用岗位和简历本地规则"}, localSuggestion.Reasons...)
			return useLocalRuleReply(localSuggestion), nil
		}
		return completeSuggestionWithClient(request.Context(), localSuggestion, server.codexClient, "Codex", "codex", systemPrompt, userPrompt), nil
	case aiReplyProviderDeepSeek:
		return completeSuggestionWithClient(request.Context(), localSuggestion, server.deepSeekClient(aiReplySettings), "DeepSeek", "deepseek", systemPrompt, userPrompt), nil
	case aiReplyProviderZhipu:
		return completeSuggestionWithClient(request.Context(), localSuggestion, server.zhipuCompletionClient(aiReplySettings), "智谱 GLM", "zhipu", systemPrompt, userPrompt), nil
	default:
		localSuggestion.Reasons = append([]string{"回复模型来源无效，已使用岗位和简历本地规则"}, localSuggestion.Reasons...)
		return useLocalRuleReply(localSuggestion), nil
	}
}

func completeSuggestionWithClient(ctx context.Context, localSuggestion domain.ChatSuggestion, client ChatCompletionClient, providerLabel string, generator string, systemPrompt string, userPrompt string) domain.ChatSuggestion {
	if client == nil || !client.Configured() {
		localSuggestion.Reasons = append([]string{providerLabel + "当前未配置或不可用，已使用岗位和简历本地规则"}, localSuggestion.Reasons...)
		return useLocalRuleReply(localSuggestion)
	}

	completion, completeErr := client.Complete(ctx, systemPrompt, userPrompt)
	if completeErr != nil {
		localSuggestion.Reasons = append([]string{providerLabel + "调用失败，已降级为岗位和简历本地规则：" + completeErr.Error()}, localSuggestion.Reasons...)
		return useLocalRuleReply(localSuggestion)
	}

	completion = utils.CleanText(completion, 500)
	if completion == "" {
		localSuggestion.Reasons = append([]string{providerLabel + "返回空内容，已降级为岗位和简历本地规则"}, localSuggestion.Reasons...)
		return useLocalRuleReply(localSuggestion)
	}

	localSuggestion.RecommendedReply = completion
	localSuggestion.Generator = generator
	localSuggestion.Reasons = append([]string{providerLabel + "已根据岗位和简历事实生成回复"}, localSuggestion.Reasons...)
	return localSuggestion
}

func (server *Server) handleGetDeliveryStrategy(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"strategy": normalizeDeliveryStrategy(server.store.GetDeliveryStrategy()),
	})
}

func (server *Server) handleSaveDeliveryStrategy(responseWriter http.ResponseWriter, request *http.Request) {
	var payload domain.DeliveryStrategy
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	deliveryStrategy := normalizeDeliveryStrategy(payload)
	if saveErr := server.store.SaveDeliveryStrategy(deliveryStrategy); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	server.logger.Info(
		"投递策略已保存",
		"minScore", deliveryStrategy.MinMatchScore,
		"batchLimit", deliveryStrategy.BatchPrepareLimit,
		"minSalaryK", deliveryStrategy.MinSalaryK,
		"maxSalaryK", deliveryStrategy.MaxSalaryK,
	)
	writeJSON(responseWriter, http.StatusOK, map[string]any{"strategy": deliveryStrategy})
}

func (server *Server) handleListDeliveryQueue(responseWriter http.ResponseWriter, request *http.Request) {
	queueItems := server.store.ListQueueItems()
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"items": queueItems,
		"stats": buildDeliveryQueueStats(queueItems),
	})
}

type addDeliveryQueueRequest struct {
	Jobs            []domain.VisibleJob `json:"jobs"`
	CandidateSkills []string            `json:"candidateSkills"`
	MinScore        int                 `json:"minScore"`
	IncludeAll      bool                `json:"includeAll"`
}

func (server *Server) handleAddDeliveryQueue(responseWriter http.ResponseWriter, request *http.Request) {
	var payload addDeliveryQueueRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	deliveryStrategy := server.resolveDeliveryStrategy(payload.MinScore)
	candidateSkills := server.resolveCandidateSkills(payload.CandidateSkills)
	visibleAnalyses, analyzeErr := analyzeVisibleJobs(payload.Jobs, candidateSkills, deliveryStrategy)
	if analyzeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, analyzeErr)
		return
	}
	if saveErr := server.saveVisibleJobAnalyses(visibleAnalyses); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	queueItems := make([]domain.DeliveryQueueItem, 0, len(visibleAnalyses))
	for _, visibleAnalysis := range visibleAnalyses {
		if visibleAnalysis.HardBlocked {
			continue
		}
		if !payload.IncludeAll && !visibleAnalysis.Eligible {
			continue
		}
		queueItem, buildErr := buildQueueItem(visibleAnalysis)
		if buildErr != nil {
			writeError(responseWriter, http.StatusInternalServerError, buildErr)
			return
		}
		queueItems = append(queueItems, queueItem)
	}

	if len(queueItems) == 0 {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("没有符合投递策略的岗位"))
		return
	}
	if saveErr := server.store.SaveQueueItems(queueItems); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"items": queueItems})
}

type prepareDeliveryQueueRequest struct {
	QueueItemID string `json:"queueItemId"`
	ResumeID    string `json:"resumeId"`
	Mode        string `json:"mode"`
}

func (server *Server) handlePrepareDeliveryQueue(responseWriter http.ResponseWriter, request *http.Request) {
	var payload prepareDeliveryQueueRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	queueItem, exists := server.store.GetQueueItem(payload.QueueItemID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("投递队列项不存在"))
		return
	}

	jobAnalysis, jobExists := server.store.GetJob(queueItem.JobID)
	if !jobExists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("队列岗位分析不存在"))
		return
	}

	mode := server.resolveChatMode(payload.Mode)
	preparedItem, suggestion, prepareErr := server.prepareQueueItem(request, queueItem, jobAnalysis, payload.ResumeID, mode)
	if prepareErr != nil {
		writeError(responseWriter, http.StatusBadRequest, prepareErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"item":       preparedItem,
		"suggestion": suggestion,
	})
}

type prepareAllDeliveryQueueRequest struct {
	ResumeID string `json:"resumeId"`
	Mode     string `json:"mode"`
	Limit    int    `json:"limit"`
}

func (server *Server) handlePrepareAllDeliveryQueue(responseWriter http.ResponseWriter, request *http.Request) {
	var payload prepareAllDeliveryQueueRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	deliveryStrategy := normalizeDeliveryStrategy(server.store.GetDeliveryStrategy())
	limit := normalizePrepareLimit(payload.Limit, deliveryStrategy.BatchPrepareLimit)
	mode := server.resolveChatMode(payload.Mode)
	preparedItems := make([]domain.DeliveryQueueItem, 0, limit)
	failedItems := make([]map[string]string, 0)

	for _, queueItem := range server.store.ListQueueItems() {
		if len(preparedItems) >= limit {
			break
		}
		if !canPrepareQueueStatus(queueItem.Status) {
			continue
		}
		if !server.queueItemMatchesDeliveryStrategy(queueItem, deliveryStrategy) {
			continue
		}

		jobAnalysis, jobExists := server.store.GetJob(queueItem.JobID)
		if !jobExists {
			failedItems = append(failedItems, map[string]string{"id": queueItem.ID, "error": "队列岗位分析不存在"})
			continue
		}

		preparedItem, _, prepareErr := server.prepareQueueItem(request, queueItem, jobAnalysis, payload.ResumeID, mode)
		if prepareErr != nil {
			failedItems = append(failedItems, map[string]string{"id": queueItem.ID, "error": prepareErr.Error()})
			continue
		}
		preparedItems = append(preparedItems, preparedItem)
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"items":  preparedItems,
		"failed": failedItems,
		"limit":  limit,
	})
}

type requestQueueFillRequest struct {
	QueueItemID string `json:"queueItemId"`
	ResumeID    string `json:"resumeId"`
	Mode        string `json:"mode"`
}

type deliveryFillTask struct {
	QueueItemID string    `json:"queueItemId"`
	JobURL      string    `json:"jobUrl"`
	Title       string    `json:"title"`
	Company     string    `json:"company"`
	Draft       string    `json:"draft"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (server *Server) handleRequestQueueFill(responseWriter http.ResponseWriter, request *http.Request) {
	var payload requestQueueFillRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	queueItem, prepareErr := server.resolveFillQueueItem(request, payload)
	if prepareErr != nil {
		writeError(responseWriter, http.StatusBadRequest, prepareErr)
		return
	}
	if queueItem.URL == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("队列岗位缺少 BOSS 地址"))
		return
	}

	queueItem.Status = queueStatusOpened
	queueItem.UpdatedAt = time.Now()
	if updateErr := server.store.UpdateQueueItem(queueItem); updateErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, updateErr)
		return
	}

	fillTask := buildDeliveryFillTask(queueItem)
	server.saveFillTask(fillTask)
	server.logger.Info("待填话术已创建", "queueItemId", queueItem.ID, "company", queueItem.Company)
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"item": queueItem,
		"task": fillTask,
	})
}

func (server *Server) resolveFillQueueItem(request *http.Request, payload requestQueueFillRequest) (domain.DeliveryQueueItem, error) {
	queueItemID := utils.CleanText(payload.QueueItemID, 120)
	if queueItemID == "" {
		return domain.DeliveryQueueItem{}, fmt.Errorf("队列项 ID 不能为空")
	}

	queueItem, exists := server.store.GetQueueItem(queueItemID)
	if !exists {
		return domain.DeliveryQueueItem{}, fmt.Errorf("投递队列项不存在")
	}
	if isFinalQueueStatus(queueItem.Status) {
		return domain.DeliveryQueueItem{}, fmt.Errorf("该岗位已结束处理，不能再次填入")
	}
	if strings.TrimSpace(queueItem.OpeningDraft) != "" {
		return queueItem, nil
	}

	jobAnalysis, jobExists := server.store.GetJob(queueItem.JobID)
	if !jobExists {
		return domain.DeliveryQueueItem{}, fmt.Errorf("队列岗位分析不存在")
	}
	mode := server.resolveChatMode(payload.Mode)
	preparedItem, _, prepareErr := server.prepareQueueItem(request, queueItem, jobAnalysis, payload.ResumeID, mode)
	if prepareErr != nil {
		return domain.DeliveryQueueItem{}, prepareErr
	}
	if strings.TrimSpace(preparedItem.OpeningDraft) == "" {
		return domain.DeliveryQueueItem{}, fmt.Errorf("话术为空，不能填入")
	}
	return preparedItem, nil
}

func buildDeliveryFillTask(queueItem domain.DeliveryQueueItem) deliveryFillTask {
	now := time.Now()
	return deliveryFillTask{
		QueueItemID: queueItem.ID,
		JobURL:      queueItem.URL,
		Title:       queueItem.Title,
		Company:     queueItem.Company,
		Draft:       queueItem.OpeningDraft,
		CreatedAt:   now,
		ExpiresAt:   now.Add(fillTaskTTL),
	}
}

func (server *Server) saveFillTask(fillTask deliveryFillTask) {
	server.fillTaskMutex.Lock()
	defer server.fillTaskMutex.Unlock()

	server.fillTasks[fillTask.QueueItemID] = fillTask
}

func (server *Server) handleGetFillTask(responseWriter http.ResponseWriter, request *http.Request) {
	currentURL := utils.CleanText(request.URL.Query().Get("url"), 800)
	queueItemID := utils.CleanText(request.URL.Query().Get("queueItemId"), 120)
	fillTask, exists := server.findFillTask(queueItemID, currentURL, time.Now())
	if !exists {
		writeJSON(responseWriter, http.StatusOK, map[string]any{"task": nil})
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"task": fillTask})
}

func (server *Server) findFillTask(queueItemID string, currentURL string, now time.Time) (deliveryFillTask, bool) {
	server.fillTaskMutex.Lock()
	defer server.fillTaskMutex.Unlock()

	if queueItemID != "" {
		fillTask, exists := server.fillTasks[queueItemID]
		if exists && !now.After(fillTask.ExpiresAt) {
			return fillTask, true
		}
		if exists {
			delete(server.fillTasks, queueItemID)
		}
	}

	activeTasks := make([]deliveryFillTask, 0, len(server.fillTasks))
	for queueItemID, fillTask := range server.fillTasks {
		if now.After(fillTask.ExpiresAt) {
			delete(server.fillTasks, queueItemID)
			continue
		}
		if fillTaskMatchesURL(fillTask.JobURL, currentURL) {
			return fillTask, true
		}
		activeTasks = append(activeTasks, fillTask)
	}

	if len(activeTasks) == 1 && isBossURL(currentURL) {
		return activeTasks[0], true
	}
	return deliveryFillTask{}, false
}

type completeFillTaskRequest struct {
	QueueItemID string `json:"queueItemId"`
	Status      string `json:"status"`
	Error       string `json:"error"`
}

func (server *Server) handleCompleteFillTask(responseWriter http.ResponseWriter, request *http.Request) {
	var payload completeFillTaskRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	queueItemID := utils.CleanText(payload.QueueItemID, 120)
	if queueItemID == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("队列项 ID 不能为空"))
		return
	}
	if payload.Status != queueStatusFilled {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("待填任务状态不合法"))
		return
	}

	queueItem, exists := server.store.GetQueueItem(queueItemID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("投递队列项不存在"))
		return
	}
	queueItem.Status = queueStatusFilled
	queueItem.UpdatedAt = time.Now()
	if updateErr := server.store.UpdateQueueItem(queueItem); updateErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, updateErr)
		return
	}

	server.fillTaskMutex.Lock()
	delete(server.fillTasks, queueItemID)
	server.fillTaskMutex.Unlock()
	server.logger.Info("话术已填入 BOSS 输入框", "queueItemId", queueItemID)
	writeJSON(responseWriter, http.StatusOK, map[string]any{"item": queueItem})
}

type updateDeliveryQueueStatusRequest struct {
	QueueItemID string `json:"queueItemId"`
	Status      string `json:"status"`
	Notes       string `json:"notes"`
}

func (server *Server) handleUpdateDeliveryQueueStatus(responseWriter http.ResponseWriter, request *http.Request) {
	var payload updateDeliveryQueueStatusRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	queueItem, exists := server.store.GetQueueItem(payload.QueueItemID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("投递队列项不存在"))
		return
	}

	status := utils.CleanText(payload.Status, 30)
	if !isAllowedQueueStatus(status) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("投递状态不合法"))
		return
	}

	queueItem.Status = status
	queueItem.UpdatedAt = time.Now()
	if updateErr := server.store.UpdateQueueItem(queueItem); updateErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, updateErr)
		return
	}

	if status == queueStatusDelivered {
		server.saveDeliveryFeedback(queueItem, payload.Notes)
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"item": queueItem})
}

type sandboxAutoChatRequest struct {
	JobID    string `json:"jobId"`
	ResumeID string `json:"resumeId"`
	Rounds   int    `json:"rounds"`
}

func (server *Server) handleSandboxAutoChat(responseWriter http.ResponseWriter, request *http.Request) {
	var payload sandboxAutoChatRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}
	if payload.Rounds <= 0 || payload.Rounds > 5 {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("沙箱轮次必须在 1 到 5 之间"))
		return
	}

	jobAnalysis, exists := server.store.GetJob(payload.JobID)
	if !exists {
		writeError(responseWriter, http.StatusNotFound, fmt.Errorf("岗位分析不存在"))
		return
	}

	var resumePointer *domain.ResumeVersion
	if payload.ResumeID != "" {
		resumeVersion, resumeExists := server.store.GetResume(payload.ResumeID)
		if !resumeExists {
			writeError(responseWriter, http.StatusNotFound, fmt.Errorf("简历不存在"))
			return
		}
		resumePointer = &resumeVersion
	}

	messages := make([]domain.Message, 0, payload.Rounds*2)
	for round := 0; round < payload.Rounds; round++ {
		recruiterMessage := domain.Message{
			Role:      "recruiter",
			Content:   sandboxRecruiterQuestion(round),
			CreatedAt: time.Now(),
		}
		messages = append(messages, recruiterMessage)

		suggestion := chat.Suggest(jobAnalysis, resumePointer, messages, "积极主动")
		messages = append(messages, domain.Message{
			Role:      "candidate",
			Content:   suggestion.RecommendedReply,
			CreatedAt: time.Now(),
		})
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"messages": messages})
}

type feedbackRequest struct {
	JobID    string `json:"jobId"`
	Company  string `json:"company"`
	ResumeID string `json:"resumeId"`
	Status   string `json:"status"`
	Message  string `json:"message"`
	Notes    string `json:"notes"`
}

func (server *Server) handleFeedback(responseWriter http.ResponseWriter, request *http.Request) {
	var payload feedbackRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	feedbackID, idErr := utils.NewID("feedback")
	if idErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, idErr)
		return
	}

	status := utils.CleanText(payload.Status, 20)
	if status == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("反馈状态不能为空"))
		return
	}

	feedbackRecord := domain.FeedbackRecord{
		ID:        feedbackID,
		JobID:     utils.CleanText(payload.JobID, 120),
		Company:   utils.CleanText(payload.Company, 80),
		ResumeID:  utils.CleanText(payload.ResumeID, 120),
		Status:    status,
		Message:   utils.CleanText(payload.Message, 1000),
		Notes:     utils.CleanText(payload.Notes, 1000),
		CreatedAt: time.Now(),
	}

	if saveErr := server.store.SaveFeedback(feedbackRecord); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"feedback": feedbackRecord})
}

func (server *Server) handleListFeedback(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{"feedbacks": server.store.ListFeedbacks()})
}

// 解析请求：限制体积和未知字段，避免过大输入和静默兼容错误。
func (server *Server) decodeJSON(request *http.Request, target any) error {
	defer request.Body.Close()

	limitedReader := io.LimitReader(request.Body, server.maxRequestSize+1)
	body, readErr := io.ReadAll(limitedReader)
	if readErr != nil {
		return fmt.Errorf("读取请求体失败: %w", readErr)
	}
	if int64(len(body)) > server.maxRequestSize {
		return fmt.Errorf("请求体超过限制")
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decodeErr := decoder.Decode(target); decodeErr != nil {
		return fmt.Errorf("解析请求 JSON 失败: %w", decodeErr)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("请求 JSON 只能包含一个对象")
	}
	return nil
}

func writeJSON(responseWriter http.ResponseWriter, statusCode int, payload any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.WriteHeader(statusCode)
	if encodeErr := json.NewEncoder(responseWriter).Encode(payload); encodeErr != nil {
		http.Error(responseWriter, "编码响应失败", http.StatusInternalServerError)
	}
}

func writeError(responseWriter http.ResponseWriter, statusCode int, err error) {
	if err == nil {
		err = errors.New("未知错误")
	}
	writeJSON(responseWriter, statusCode, map[string]string{"error": err.Error()})
}

func sandboxRecruiterQuestion(round int) string {
	questions := []string{
		"你这边有相关项目经验吗？",
		"能简单说下你在项目里负责什么吗？",
		"你什么时候方便面试？",
		"你对薪资和办公地点有什么要求？",
		"可以发一份针对岗位整理的简历吗？",
	}
	if round < len(questions) {
		return questions[round]
	}
	return questions[len(questions)-1]
}

func analyzeVisibleJobs(visibleJobs []domain.VisibleJob, candidateSkills []string, deliveryStrategy domain.DeliveryStrategy) ([]domain.VisibleJobAnalysis, error) {
	if len(visibleJobs) == 0 {
		return nil, fmt.Errorf("当前页没有可分析岗位")
	}
	if len(visibleJobs) > maxVisibleJobCount {
		visibleJobs = visibleJobs[:maxVisibleJobCount]
	}

	normalizedStrategy := normalizeDeliveryStrategy(deliveryStrategy)
	visibleAnalyses := make([]domain.VisibleJobAnalysis, 0, len(visibleJobs))
	for jobIndex, visibleJob := range visibleJobs {
		cleanedJob := cleanVisibleJob(visibleJob, jobIndex)
		description := buildVisibleJobDescription(cleanedJob)
		jobAnalysis, analyzeErr := job.Analyze(description, cleanedJob.Title, cleanedJob.Company, candidateSkills)
		if analyzeErr != nil {
			continue
		}
		jobAnalysis = applyVisibleJobMetadata(jobAnalysis, cleanedJob)

		eligible, hardBlocked, filterReasons := evaluateDeliveryStrategy(cleanedJob, jobAnalysis, normalizedStrategy)
		visibleAnalyses = append(visibleAnalyses, domain.VisibleJobAnalysis{
			ClientID:      cleanedJob.ClientID,
			Source:        cleanedJob,
			Analysis:      jobAnalysis,
			HighMatch:     eligible,
			Eligible:      eligible,
			HardBlocked:   hardBlocked,
			FilterReasons: filterReasons,
			QueueStatus:   "new",
		})
	}

	if len(visibleAnalyses) == 0 {
		return nil, fmt.Errorf("当前页岗位内容不足，无法分析")
	}
	return visibleAnalyses, nil
}

func (server *Server) saveVisibleJobAnalyses(visibleAnalyses []domain.VisibleJobAnalysis) error {
	jobAnalyses := make([]domain.JobAnalysis, 0, len(visibleAnalyses))
	for _, visibleAnalysis := range visibleAnalyses {
		jobAnalyses = append(jobAnalyses, visibleAnalysis.Analysis)
	}

	savedJobs, saveErr := server.store.SaveJobsAndReturn(jobAnalyses)
	if saveErr != nil {
		return fmt.Errorf("保存抓取岗位失败: %w", saveErr)
	}

	for jobIndex := range visibleAnalyses {
		if jobIndex < len(savedJobs) {
			visibleAnalyses[jobIndex].Analysis = savedJobs[jobIndex]
		}
	}
	server.logger.Info("抓取岗位已入库", "count", len(savedJobs))
	return nil
}

func applyVisibleJobMetadata(jobAnalysis domain.JobAnalysis, visibleJob domain.VisibleJob) domain.JobAnalysis {
	jobAnalysis.Location = visibleJob.Location
	jobAnalysis.Salary = visibleJob.Salary
	jobAnalysis.URL = visibleJob.URL
	return jobAnalysis
}

func evaluateDeliveryStrategy(visibleJob domain.VisibleJob, jobAnalysis domain.JobAnalysis, deliveryStrategy domain.DeliveryStrategy) (bool, bool, []string) {
	filterReasons := make([]string, 0)
	hardBlocked := false

	if jobAnalysis.MatchScore < deliveryStrategy.MinMatchScore {
		filterReasons = append(filterReasons, fmt.Sprintf("匹配度低于阈值 %d", deliveryStrategy.MinMatchScore))
	}

	hardBlocked = appendSalaryFilterReason(&filterReasons, visibleJob.Salary, deliveryStrategy) || hardBlocked
	hardBlocked = appendTitleFilterReasons(&filterReasons, visibleJob.Title, deliveryStrategy.IncludeTitleKeywords, deliveryStrategy.ExcludeTitleKeywords) || hardBlocked
	hardBlocked = appendKeywordFilterReasons(&filterReasons, "公司名称", visibleJob.Company, deliveryStrategy.IncludeCompanyKeywords, deliveryStrategy.ExcludeCompanyKeywords) || hardBlocked
	hardBlocked = appendKeywordFilterReasons(&filterReasons, "岗位内容", visibleJob.Description, deliveryStrategy.IncludeDescriptionKeywords, deliveryStrategy.ExcludeDescriptionKeywords) || hardBlocked

	return len(filterReasons) == 0, hardBlocked, filterReasons
}

// 自动队列只选择符合当前岗位方向的记录；切换目标时保留旧记录，便于以后恢复原方向。
func (server *Server) queueItemMatchesDeliveryStrategy(queueItem domain.DeliveryQueueItem, deliveryStrategy domain.DeliveryStrategy) bool {
	visibleJob := domain.VisibleJob{
		Title:    queueItem.Title,
		Company:  queueItem.Company,
		Location: queueItem.Location,
		Salary:   queueItem.Salary,
		URL:      queueItem.URL,
	}
	jobAnalysis := domain.JobAnalysis{MatchScore: queueItem.MatchScore}
	if storedJob, exists := server.store.GetJob(queueItem.JobID); exists {
		visibleJob.Description = storedJob.Description
		jobAnalysis = storedJob
		if jobAnalysis.MatchScore == 0 {
			jobAnalysis.MatchScore = queueItem.MatchScore
		}
	}

	_, hardBlocked, _ := evaluateDeliveryStrategy(visibleJob, jobAnalysis, deliveryStrategy)
	return !hardBlocked
}

func appendTitleFilterReasons(filterReasons *[]string, title string, includeKeywords []string, excludeKeywords []string) bool {
	hardBlocked := false
	allowRelatedBackendTitle := isGoBackendTarget(includeKeywords) && isRelatedBackendTitle(title)
	if len(includeKeywords) > 0 && len(matchKeywords(title, includeKeywords)) == 0 && !allowRelatedBackendTitle {
		*filterReasons = append(*filterReasons, "岗位名称未命中目标岗位关键词")
		hardBlocked = true
	}

	matchedExcludeKeywords := matchKeywords(title, excludeKeywords)
	if len(matchedExcludeKeywords) > 0 {
		*filterReasons = append(*filterReasons, "岗位名称命中屏蔽关键词："+strings.Join(matchedExcludeKeywords, "、"))
		hardBlocked = true
	}
	return hardBlocked
}

// 只有 Go 后端目标允许通用“后端”标题，其他目标必须命中用户填写的岗位关键词。
func isGoBackendTarget(includeKeywords []string) bool {
	normalizedKeywords := strings.ToLower(strings.ReplaceAll(strings.Join(includeKeywords, ""), " ", ""))
	for _, keyword := range []string{"golang", "go语言", "go后端"} {
		if strings.Contains(normalizedKeywords, keyword) {
			return true
		}
	}
	return false
}

func isRelatedBackendTitle(title string) bool {
	normalizedTitle := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(title), " ", ""))
	for _, unrelatedTechnology := range []string{"java", "python", "php", "c++", "c#", ".net", "node.js", "nodejs", "rust", "scala", "kotlin"} {
		if strings.Contains(normalizedTitle, unrelatedTechnology) {
			return false
		}
	}
	for _, keyword := range []string{"后端", "后台开发", "服务端", "全栈", "backend"} {
		if strings.Contains(normalizedTitle, keyword) {
			return true
		}
	}
	return false
}

// 功能目的：按薪资策略过滤岗位；实现原因：只排除与目标薪资完全不相交的岗位，避免误伤仍可谈到目标范围的岗位。
func appendSalaryFilterReason(filterReasons *[]string, salaryText string, deliveryStrategy domain.DeliveryStrategy) bool {
	if deliveryStrategy.MinSalaryK <= 0 && deliveryStrategy.MaxSalaryK <= 0 {
		return false
	}

	salaryRange := parseSalaryRangeK(salaryText)
	if !salaryRange.Known {
		if deliveryStrategy.AllowUnknownSalary {
			return false
		}
		*filterReasons = append(*filterReasons, "薪资未知且策略不允许未知薪资")
		return true
	}

	if deliveryStrategy.MinSalaryK > 0 && salaryRange.MaxK < deliveryStrategy.MinSalaryK {
		*filterReasons = append(*filterReasons, fmt.Sprintf("薪资整体低于目标范围：%s，岗位最高薪资低于 %dK", salaryText, deliveryStrategy.MinSalaryK))
		return true
	}
	// 目标薪资上限允许 10K 浮动；岗位薪资略高仍属于相似范围，不应错过可谈岗位。
	if deliveryStrategy.MaxSalaryK > 0 && salaryRange.MinK > deliveryStrategy.MaxSalaryK+similarSalaryUpperGapK {
		*filterReasons = append(*filterReasons, fmt.Sprintf("薪资明显高于目标范围：%s，岗位最低薪资高于目标上限 %dK 超过 %dK", salaryText, deliveryStrategy.MaxSalaryK, similarSalaryUpperGapK))
		return true
	}

	return false
}

// 功能目的：解析月薪 K 区间；实现原因：BOSS 薪资文本需要转换为可比较数字。
func parseSalaryRangeK(salaryText string) salaryRangeK {
	cleanedSalary := decodeBossSalaryText(strings.TrimSpace(salaryText))
	if cleanedSalary == "" || strings.Contains(cleanedSalary, "面议") {
		return salaryRangeK{}
	}

	if matchedParts := monthlyKSalaryPattern.FindStringSubmatch(cleanedSalary); len(matchedParts) == 3 {
		return buildSalaryRangeK(parseSalaryNumberK(matchedParts[1], 1), parseSalaryNumberK(matchedParts[2], 1))
	}
	if matchedParts := monthlyWanSalaryPattern.FindStringSubmatch(cleanedSalary); len(matchedParts) == 3 {
		return buildSalaryRangeK(parseSalaryNumberK(matchedParts[1], 10), parseSalaryNumberK(matchedParts[2], 10))
	}
	if matchedParts := singleMonthlyKSalaryPattern.FindStringSubmatch(cleanedSalary); len(matchedParts) == 2 {
		salaryK := parseSalaryNumberK(matchedParts[1], 1)
		return buildSalaryRangeK(salaryK, salaryK)
	}

	return salaryRangeK{}
}

// decodeBossSalaryText 还原 BOSS 私有字体数字，避免混淆字符绕过薪资过滤。
func decodeBossSalaryText(salaryText string) string {
	var decodedSalary strings.Builder
	decodedSalary.Grow(len(salaryText))
	for _, character := range salaryText {
		if character >= '\uE030' && character <= '\uE039' {
			decodedSalary.WriteRune('0' + character - '\uE030')
			continue
		}
		decodedSalary.WriteRune(character)
	}
	return decodedSalary.String()
}

// 功能目的：转换薪资数字；实现原因：薪资可能包含小数万，需要向上取整避免低估要求。
func parseSalaryNumberK(rawNumber string, multiplier float64) int {
	parsedNumber, parseErr := strconv.ParseFloat(rawNumber, 64)
	if parseErr != nil || parsedNumber <= 0 {
		return 0
	}
	return int(math.Ceil(parsedNumber * multiplier))
}

// 功能目的：构造有效薪资区间；实现原因：上游文本可能出现顺序异常，比较前需要边界稳定。
func buildSalaryRangeK(minK int, maxK int) salaryRangeK {
	if minK <= 0 || maxK <= 0 {
		return salaryRangeK{}
	}
	if minK > maxK {
		minK, maxK = maxK, minK
	}
	return salaryRangeK{MinK: minK, MaxK: maxK, Known: true}
}

func appendKeywordFilterReasons(filterReasons *[]string, fieldName string, fieldValue string, includeKeywords []string, excludeKeywords []string) bool {
	hardBlocked := false

	if len(includeKeywords) > 0 && !utils.ContainsAnyFold(fieldValue, includeKeywords) {
		*filterReasons = append(*filterReasons, fieldName+"未命中必须关键词："+strings.Join(includeKeywords, "、"))
		hardBlocked = true
	}

	matchedExcludeKeywords := matchKeywords(fieldValue, excludeKeywords)
	if len(matchedExcludeKeywords) > 0 {
		*filterReasons = append(*filterReasons, fieldName+"命中屏蔽关键词："+strings.Join(matchedExcludeKeywords, "、"))
		hardBlocked = true
	}

	return hardBlocked
}

func matchKeywords(text string, keywords []string) []string {
	matchedKeywords := make([]string, 0)
	lowerText := strings.ToLower(text)
	for _, keyword := range keywords {
		cleanedKeyword := strings.TrimSpace(keyword)
		if cleanedKeyword == "" {
			continue
		}
		if strings.Contains(lowerText, strings.ToLower(cleanedKeyword)) {
			matchedKeywords = append(matchedKeywords, cleanedKeyword)
		}
	}
	return utils.UniqueNonEmpty(matchedKeywords)
}

func cleanVisibleJob(visibleJob domain.VisibleJob, jobIndex int) domain.VisibleJob {
	clientID := utils.CleanText(visibleJob.ClientID, 60)
	if clientID == "" {
		clientID = fmt.Sprintf("visible_%d", jobIndex)
	}

	return domain.VisibleJob{
		ClientID:    clientID,
		Title:       utils.CleanText(visibleJob.Title, 100),
		Company:     utils.CleanText(visibleJob.Company, 100),
		Location:    utils.CleanText(visibleJob.Location, 80),
		Salary:      decodeBossSalaryText(utils.CleanText(visibleJob.Salary, 60)),
		URL:         utils.CleanText(visibleJob.URL, 500),
		Description: utils.CleanText(visibleJob.Description, 4000),
	}
}

func buildVisibleJobDescription(visibleJob domain.VisibleJob) string {
	parts := []string{
		visibleJob.Title,
		visibleJob.Company,
		visibleJob.Location,
		visibleJob.Salary,
		visibleJob.Description,
	}
	return utils.CleanText(strings.Join(parts, " "), 6000)
}

func buildQueueItem(visibleAnalysis domain.VisibleJobAnalysis) (domain.DeliveryQueueItem, error) {
	queueItemID, idErr := utils.NewID("queue")
	if idErr != nil {
		return domain.DeliveryQueueItem{}, idErr
	}

	now := time.Now()
	return domain.DeliveryQueueItem{
		ID:             queueItemID,
		JobID:          visibleAnalysis.Analysis.ID,
		Title:          visibleAnalysis.Source.Title,
		Company:        visibleAnalysis.Source.Company,
		Location:       visibleAnalysis.Source.Location,
		Salary:         visibleAnalysis.Source.Salary,
		URL:            visibleAnalysis.Source.URL,
		MatchScore:     visibleAnalysis.Analysis.MatchScore,
		Recommendation: visibleAnalysis.Analysis.Recommendation,
		Keywords:       visibleAnalysis.Analysis.Keywords,
		FilterReasons:  visibleAnalysis.FilterReasons,
		Status:         queueStatusQueued,
		CreatedAt:      now,
		UpdatedAt:      now,
	}, nil
}

func normalizeMinScore(minScore int) int {
	if minScore <= 0 {
		return defaultHighMatchScore
	}
	if minScore > 100 {
		return 100
	}
	return minScore
}

func (server *Server) resolveDeliveryStrategy(requestMinScore int) domain.DeliveryStrategy {
	deliveryStrategy := normalizeDeliveryStrategy(server.store.GetDeliveryStrategy())
	if requestMinScore > 0 {
		deliveryStrategy.MinMatchScore = normalizeMinScore(requestMinScore)
	}
	return deliveryStrategy
}

func normalizeDeliveryStrategy(deliveryStrategy domain.DeliveryStrategy) domain.DeliveryStrategy {
	defaultStrategy := domain.DefaultDeliveryStrategy()
	if deliveryStrategy.MinMatchScore <= 0 {
		deliveryStrategy.MinMatchScore = defaultStrategy.MinMatchScore
	}
	if deliveryStrategy.MinMatchScore > 100 {
		deliveryStrategy.MinMatchScore = 100
	}
	deliveryStrategy.MinMatchScore = fixedMinMatchScore
	if deliveryStrategy.BatchPrepareLimit <= 0 {
		deliveryStrategy.BatchPrepareLimit = defaultStrategy.BatchPrepareLimit
	}
	if deliveryStrategy.BatchPrepareLimit > maxBatchPrepareCount {
		deliveryStrategy.BatchPrepareLimit = maxBatchPrepareCount
	}
	// 薪资采用用户当前填写值，避免页面显示与后台过滤不一致。
	if deliveryStrategy.MinSalaryK < 0 {
		deliveryStrategy.MinSalaryK = 0
	}
	if deliveryStrategy.MaxSalaryK < 0 {
		deliveryStrategy.MaxSalaryK = 0
	}
	if deliveryStrategy.MinSalaryK > maxStrategySalaryK {
		deliveryStrategy.MinSalaryK = maxStrategySalaryK
	}
	if deliveryStrategy.MaxSalaryK > maxStrategySalaryK {
		deliveryStrategy.MaxSalaryK = maxStrategySalaryK
	}
	if deliveryStrategy.MinSalaryK == 0 && deliveryStrategy.MaxSalaryK == 0 {
		deliveryStrategy.MinSalaryK = defaultStrategy.MinSalaryK
		deliveryStrategy.MaxSalaryK = defaultStrategy.MaxSalaryK
		deliveryStrategy.AllowUnknownSalary = defaultStrategy.AllowUnknownSalary
	}
	if deliveryStrategy.MinSalaryK > 0 && deliveryStrategy.MaxSalaryK > 0 && deliveryStrategy.MinSalaryK > deliveryStrategy.MaxSalaryK {
		deliveryStrategy.MinSalaryK, deliveryStrategy.MaxSalaryK = deliveryStrategy.MaxSalaryK, deliveryStrategy.MinSalaryK
	}

	deliveryStrategy.DefaultChatMode = utils.CleanText(deliveryStrategy.DefaultChatMode, 30)
	if deliveryStrategy.DefaultChatMode == "" {
		deliveryStrategy.DefaultChatMode = defaultStrategy.DefaultChatMode
	}
	deliveryStrategy.GreetingPrompt = utils.CleanText(deliveryStrategy.GreetingPrompt, 300)
	deliveryStrategy.IncludeTitleKeywords = normalizeStrategyKeywords(deliveryStrategy.IncludeTitleKeywords)
	if len(deliveryStrategy.IncludeTitleKeywords) == 0 {
		deliveryStrategy.IncludeTitleKeywords = normalizeStrategyKeywords(defaultStrategy.IncludeTitleKeywords)
	}
	deliveryStrategy.ExcludeTitleKeywords = appendMandatoryStrategyKeywords(normalizeStrategyKeywords(deliveryStrategy.ExcludeTitleKeywords), hunterTitleBlockKeywords)
	deliveryStrategy.IncludeCompanyKeywords = normalizeStrategyKeywords(deliveryStrategy.IncludeCompanyKeywords)
	deliveryStrategy.ExcludeCompanyKeywords = appendMandatoryStrategyKeywords(normalizeStrategyKeywords(deliveryStrategy.ExcludeCompanyKeywords), hunterCompanyBlockKeywords)
	deliveryStrategy.IncludeDescriptionKeywords = normalizeStrategyKeywords(deliveryStrategy.IncludeDescriptionKeywords)
	deliveryStrategy.ExcludeDescriptionKeywords = appendMandatoryStrategyKeywords(normalizeStrategyKeywords(deliveryStrategy.ExcludeDescriptionKeywords), hunterDescriptionBlockKeywords)
	return deliveryStrategy
}

// 功能目的：追加不可关闭的猎头屏蔽词；实现原因：用户要求猎头岗位不得进入扫描推荐链路。
func appendMandatoryStrategyKeywords(existingKeywords []string, mandatoryKeywords []string) []string {
	mergedKeywords := append([]string{}, existingKeywords...)
	mergedKeywords = append(mergedKeywords, normalizeStrategyKeywords(mandatoryKeywords)...)
	return utils.UniqueNonEmpty(mergedKeywords)
}

func normalizeStrategyKeywords(keywords []string) []string {
	cleanedKeywords := make([]string, 0, len(keywords))
	for _, keyword := range keywords {
		cleanedKeyword := utils.CleanText(keyword, maxStrategyKeywordLength)
		if cleanedKeyword == "" {
			continue
		}
		cleanedKeywords = append(cleanedKeywords, cleanedKeyword)
		if len(cleanedKeywords) >= maxStrategyKeywordCount {
			break
		}
	}
	return utils.UniqueNonEmpty(cleanedKeywords)
}

func primaryTargetRole(deliveryStrategy domain.DeliveryStrategy) string {
	for _, keyword := range normalizeStrategyKeywords(deliveryStrategy.IncludeTitleKeywords) {
		if keyword != "" {
			return keyword
		}
	}
	return defaultTargetRole
}

func (server *Server) resolveCandidateSkills(candidateSkills []string) []string {
	resolvedSkills := append([]string{}, candidateSkills...)

	resumes := server.store.ListResumes()
	if len(resumes) > 0 {
		latestResume := resumes[len(resumes)-1]
		resolvedSkills = append(resolvedSkills, latestResume.Profile.Skills...)
	}

	for _, projectSummary := range server.store.ListProjects() {
		resolvedSkills = append(resolvedSkills, projectSummary.TechStack...)
	}

	return utils.UniqueNonEmpty(resolvedSkills)
}

func (server *Server) prepareResumeForQueue(jobAnalysis domain.JobAnalysis, resumeID string) (*domain.ResumeVersion, error) {
	baseResume, exists := server.selectResumeForPrepare(resumeID)
	if !exists {
		if strings.TrimSpace(resumeID) != "" {
			return nil, fmt.Errorf("主动联系 HR 使用的简历不存在，请重新选择简历")
		}
		return nil, fmt.Errorf("主动联系 HR 前必须先导入或生成有效简历")
	}

	projects := server.store.GetProjectsByID(baseResume.ProjectIDs)
	if len(projects) == 0 {
		return &baseResume, nil
	}

	tailoredResume, generateErr := resume.Generate(baseResume.Profile, projects, &jobAnalysis)
	if generateErr != nil {
		return nil, fmt.Errorf("生成岗位定制简历失败: %w", generateErr)
	}
	if saveErr := server.store.SaveResume(tailoredResume); saveErr != nil {
		return nil, fmt.Errorf("保存岗位定制简历失败: %w", saveErr)
	}

	return &tailoredResume, nil
}

func (server *Server) selectResumeForPrepare(resumeID string) (domain.ResumeVersion, bool) {
	if strings.TrimSpace(resumeID) != "" {
		return server.store.GetResume(resumeID)
	}

	resumes := server.store.ListResumes()
	if len(resumes) == 0 {
		return domain.ResumeVersion{}, false
	}
	return resumes[len(resumes)-1], true
}

func (server *Server) prepareQueueItem(request *http.Request, queueItem domain.DeliveryQueueItem, jobAnalysis domain.JobAnalysis, resumeID string, mode string) (domain.DeliveryQueueItem, domain.ChatSuggestion, error) {
	resumePointer, prepareErr := server.prepareResumeForQueue(jobAnalysis, resumeID)
	if prepareErr != nil {
		return domain.DeliveryQueueItem{}, domain.ChatSuggestion{}, prepareErr
	}

	suggestion, suggestErr := server.buildChatSuggestion(request, jobAnalysis, resumePointer, nil, mode)
	if suggestErr != nil {
		return domain.DeliveryQueueItem{}, domain.ChatSuggestion{}, suggestErr
	}

	queueItem.OpeningDraft = suggestion.RecommendedReply
	queueItem.Status = queueStatusPrepared
	queueItem.UpdatedAt = time.Now()
	if resumePointer != nil {
		queueItem.ResumeID = resumePointer.ID
	}
	if updateErr := server.store.UpdateQueueItem(queueItem); updateErr != nil {
		return domain.DeliveryQueueItem{}, domain.ChatSuggestion{}, updateErr
	}

	return queueItem, suggestion, nil
}

func buildDeliveryQueueStats(queueItems []domain.DeliveryQueueItem) domain.DeliveryQueueStats {
	statusCounts := make(map[string]int)
	nextItemID := ""

	for _, queueItem := range queueItems {
		statusCounts[queueItem.Status]++
		if nextItemID == "" && isNextQueueCandidate(queueItem.Status) {
			nextItemID = queueItem.ID
		}
	}

	return domain.DeliveryQueueStats{
		Total:        len(queueItems),
		StatusCounts: statusCounts,
		NextItemID:   nextItemID,
	}
}

func normalizePrepareLimit(limit int, defaultLimit int) int {
	if limit <= 0 {
		if defaultLimit <= 0 {
			return maxBatchPrepareCount
		}
		if defaultLimit > maxBatchPrepareCount {
			return maxBatchPrepareCount
		}
		return defaultLimit
	}
	if limit > maxBatchPrepareCount {
		return maxBatchPrepareCount
	}
	return limit
}

func (server *Server) resolveChatMode(mode string) string {
	cleanedMode := utils.CleanText(mode, 30)
	if cleanedMode != "" {
		return cleanedMode
	}
	return normalizeDeliveryStrategy(server.store.GetDeliveryStrategy()).DefaultChatMode
}

func canPrepareQueueStatus(status string) bool {
	return status == "" || status == queueStatusQueued || status == queueStatusPrepared || status == queueStatusOpened || status == queueStatusFilled
}

func isNextQueueCandidate(status string) bool {
	return status == queueStatusPrepared || status == queueStatusQueued || status == queueStatusOpened || status == ""
}

func isAllowedQueueStatus(status string) bool {
	switch status {
	case queueStatusQueued, queueStatusPrepared, queueStatusOpened, queueStatusFilled, queueStatusDelivered, queueStatusSkipped, queueStatusRejected:
		return true
	default:
		return false
	}
}

func isFinalQueueStatus(status string) bool {
	return status == queueStatusDelivered || status == queueStatusSkipped || status == queueStatusRejected
}

func fillTaskMatchesURL(jobURL string, currentURL string) bool {
	if strings.TrimSpace(jobURL) == "" || strings.TrimSpace(currentURL) == "" {
		return false
	}
	if normalizeFillURL(jobURL) == normalizeFillURL(currentURL) {
		return true
	}

	jobKey := extractBossJobKey(jobURL)
	if jobKey == "" {
		return false
	}
	return strings.Contains(currentURL, jobKey)
}

func normalizeFillURL(rawURL string) string {
	parsedURL, parseErr := url.Parse(strings.TrimSpace(rawURL))
	if parseErr != nil {
		return strings.TrimRight(strings.TrimSpace(rawURL), "/")
	}
	parsedURL.Fragment = ""
	parsedURL.RawQuery = ""
	return strings.TrimRight(parsedURL.String(), "/")
}

func extractBossJobKey(rawURL string) string {
	parsedURL, parseErr := url.Parse(strings.TrimSpace(rawURL))
	if parseErr != nil {
		return ""
	}
	for _, queryKey := range []string{"jobId", "jobid", "lid", "securityId"} {
		queryValue := parsedURL.Query().Get(queryKey)
		if len(queryValue) >= 8 {
			return queryValue
		}
	}

	pathParts := strings.Split(strings.Trim(parsedURL.Path, "/"), "/")
	for _, pathPart := range pathParts {
		if len(pathPart) >= 8 && strings.Contains(strings.ToLower(pathPart), "job") {
			return pathPart
		}
	}
	return ""
}

func isBossURL(rawURL string) bool {
	parsedURL, parseErr := url.Parse(strings.TrimSpace(rawURL))
	if parseErr != nil {
		return false
	}
	return strings.HasSuffix(parsedURL.Hostname(), "zhipin.com")
}

func (server *Server) saveDeliveryFeedback(queueItem domain.DeliveryQueueItem, notes string) {
	feedbackID, idErr := utils.NewID("feedback")
	if idErr != nil {
		return
	}

	feedbackRecord := domain.FeedbackRecord{
		ID:        feedbackID,
		JobID:     queueItem.JobID,
		Company:   queueItem.Company,
		ResumeID:  queueItem.ResumeID,
		Status:    "已投递",
		Message:   queueItem.OpeningDraft,
		Notes:     utils.CleanText(notes, 1000),
		CreatedAt: time.Now(),
	}
	_ = server.store.SaveFeedback(feedbackRecord)
}

// 自动聊天：状态存储
type autoChatSession struct {
	QueueItemID string           `json:"queueItemId"`
	JobID       string           `json:"jobId"`
	ResumeID    string           `json:"resumeId"`
	Mode        string           `json:"mode"`
	Status      string           `json:"status"` // idle / chatting / stopped / completed / skipped
	Messages    []domain.Message `json:"messages"`
	MaxRounds   int              `json:"maxRounds"`
	RoundCount  int              `json:"roundCount"`
	UpdatedAt   time.Time        `json:"updatedAt"`
}

var autoChatSessions sync.Map // key: queueItemID -> *autoChatSession

type autoChatReplyRequest struct {
	QueueItemID    string           `json:"queueItemId"`
	JobID          string           `json:"jobId"`
	JobTitle       string           `json:"jobTitle"`
	JobCompany     string           `json:"jobCompany"`
	JobLocation    string           `json:"jobLocation"`
	JobSalary      string           `json:"jobSalary"`
	JobDescription string           `json:"jobDescription"`
	ResumeID       string           `json:"resumeId"`
	Mode           string           `json:"mode"`
	Messages       []domain.Message `json:"messages"`
	HrNewMessage   string           `json:"hrNewMessage"`
	RoundCount     int              `json:"roundCount"`
}

func (server *Server) handleAutoChatReply(responseWriter http.ResponseWriter, request *http.Request) {
	var payload autoChatReplyRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	jobID := utils.CleanText(payload.JobID, 120)
	if jobID == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("岗位 ID 不能为空"))
		return
	}

	jobAnalysis, exists := server.store.GetJob(jobID)
	if !exists {
		jobTitle := utils.CleanText(payload.JobTitle, 200)
		jobCompany := utils.CleanText(payload.JobCompany, 200)
		if jobTitle == "" && jobCompany == "" {
			writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("岗位分析不存在"))
			return
		}
		// BOSS 历史会话可能不在本系统投递队列中，使用聊天页可确认的岗位信息生成本次回复，不写入岗位库。
		jobAnalysis = domain.JobAnalysis{
			ID:          jobID,
			Title:       jobTitle,
			Company:     jobCompany,
			Location:    utils.CleanText(payload.JobLocation, 120),
			Salary:      utils.CleanText(payload.JobSalary, 80),
			Description: utils.CleanText(payload.JobDescription, 1200),
		}
	}

	resumeID := utils.CleanText(payload.ResumeID, 120)
	if resumeID == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("自动回复前必须选择有效简历"))
		return
	}
	resumeVersion, resumeExists := server.store.GetResume(resumeID)
	if !resumeExists {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("自动回复使用的简历不存在，请重新选择简历"))
		return
	}
	resumePointer := &resumeVersion

	// 构建完整的消息历史
	messages := payload.Messages
	if payload.HrNewMessage != "" {
		messages = append(messages, domain.Message{
			Role:      "recruiter",
			Content:   payload.HrNewMessage,
			CreatedAt: time.Now(),
		})
	}

	mode := utils.CleanText(payload.Mode, 20)
	if mode == "" {
		mode = "积极主动"
	}

	suggestion, suggestErr := server.buildChatSuggestion(request, jobAnalysis, resumePointer, messages, mode)
	if suggestErr != nil {
		writeError(responseWriter, http.StatusBadGateway, suggestErr)
		return
	}

	// 更新自动聊天会话
	queueItemID := utils.CleanText(payload.QueueItemID, 120)
	if queueItemID != "" {
		candidateMsg := domain.Message{
			Role:      "candidate",
			Content:   suggestion.RecommendedReply,
			CreatedAt: time.Now(),
		}
		allMessages := append(messages, candidateMsg)

		session := &autoChatSession{
			QueueItemID: queueItemID,
			JobID:       jobID,
			ResumeID:    resumeID,
			Mode:        mode,
			Status:      "chatting",
			Messages:    allMessages,
			MaxRounds:   10,
			RoundCount:  payload.RoundCount + 1,
			UpdatedAt:   time.Now(),
		}
		autoChatSessions.Store(queueItemID, session)
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"suggestion": suggestion,
		"messages":   messages,
	})
}

type updateAutoChatStatusRequest struct {
	QueueItemID string `json:"queueItemId"`
	Status      string `json:"status"` // idle / chatting / stopped / completed / skipped / rejected
}

func (server *Server) handleUpdateAutoChatStatus(responseWriter http.ResponseWriter, request *http.Request) {
	var payload updateAutoChatStatusRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	queueItemID := utils.CleanText(payload.QueueItemID, 120)
	if queueItemID == "" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("队列项 ID 不能为空"))
		return
	}

	status := utils.CleanText(payload.Status, 20)
	if status != "stopped" && status != "completed" && status != "idle" && status != "chatting" && status != "skipped" && status != "rejected" {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("自动聊天状态不合法"))
		return
	}

	if session, loaded := autoChatSessions.Load(queueItemID); loaded {
		s := session.(*autoChatSession)
		s.Status = status
		s.UpdatedAt = time.Now()
		autoChatSessions.Store(queueItemID, s)
	} else {
		autoChatSessions.Store(queueItemID, &autoChatSession{
			QueueItemID: queueItemID,
			Status:      status,
			UpdatedAt:   time.Now(),
		})
	}

	// 如果完成，更新队列状态为已投递
	if status == "completed" {
		if queueItem, exists := server.store.GetQueueItem(queueItemID); exists {
			queueItem.Status = queueStatusDelivered
			queueItem.UpdatedAt = time.Now()
			_ = server.store.UpdateQueueItem(queueItem)
			server.saveDeliveryFeedback(queueItem, "自动聊天完成")
		}
	}

	if status == "skipped" {
		if queueItem, exists := server.store.GetQueueItem(queueItemID); exists {
			queueItem.Status = queueStatusSkipped
			queueItem.UpdatedAt = time.Now()
			_ = server.store.UpdateQueueItem(queueItem)
		}
	}

	if status == "rejected" {
		if queueItem, exists := server.store.GetQueueItem(queueItemID); exists {
			queueItem.Status = queueStatusRejected
			queueItem.UpdatedAt = time.Now()
			_ = server.store.UpdateQueueItem(queueItem)
		}
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"status": status})
}

// 功能目的：获取下一个待自动处理的队列项；实现原因：全自动模式下 background 需要知道该处理哪个岗位。
func (server *Server) handleGetNextAutoQueueItem(responseWriter http.ResponseWriter, request *http.Request) {
	items := server.store.ListQueueItems()
	deliveryStrategy := normalizeDeliveryStrategy(server.store.GetDeliveryStrategy())
	eligibleItems := make([]domain.DeliveryQueueItem, 0, len(items))
	for _, item := range items {
		if isFinalQueueStatus(item.Status) {
			continue
		}

		salaryReasons := make([]string, 0, 1)
		if appendSalaryFilterReason(&salaryReasons, item.Salary, deliveryStrategy) {
			item.Status = queueStatusRejected
			item.FilterReasons = append(append([]string{}, item.FilterReasons...), salaryReasons...)
			item.UpdatedAt = time.Now()
			if updateErr := server.store.UpdateQueueItem(item); updateErr != nil {
				writeError(responseWriter, http.StatusInternalServerError, fmt.Errorf("按薪资过滤队列项 %s 失败: %w", item.ID, updateErr))
				return
			}
			server.logger.Info("队列项因薪资不符被拒绝", "queueItemId", item.ID, "salary", item.Salary, "reasons", salaryReasons)
			continue
		}
		if !server.queueItemMatchesDeliveryStrategy(item, deliveryStrategy) {
			continue
		}
		eligibleItems = append(eligibleItems, item)
	}
	items = eligibleItems

	for _, item := range items {
		// 优先返回已准备且有话术的项
		if item.Status == queueStatusPrepared && item.OpeningDraft != "" && strings.TrimSpace(item.URL) != "" {
			writeJSON(responseWriter, http.StatusOK, map[string]any{"item": item})
			return
		}
	}
	// 其次返回待准备的项
	for _, item := range items {
		if (item.Status == queueStatusQueued || item.Status == "") && strings.TrimSpace(item.URL) != "" {
			writeJSON(responseWriter, http.StatusOK, map[string]any{"item": item})
			return
		}
	}
	// 返回已打开或已填入但未完成的项
	for _, item := range items {
		if strings.TrimSpace(item.URL) == "" {
			continue
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"item": item})
		return
	}
	// 最后才返回缺少链接的项，交由后续状态修复或跳过处理。
	for _, item := range items {
		writeJSON(responseWriter, http.StatusOK, map[string]any{"item": item})
		return
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{"item": nil})
}

func buildDeepSeekChatPrompt(jobAnalysis domain.JobAnalysis, resumePointer *domain.ResumeVersion, messages []domain.Message, mode string, deliveryStrategy domain.DeliveryStrategy) string {
	var builder strings.Builder

	// 1. 岗位和公司背景
	builder.WriteString("=== 岗位背景 ===\n")
	builder.WriteString("岗位标题：" + jobAnalysis.Title + "\n")
	builder.WriteString("公司：" + jobAnalysis.Company + "\n")
	if jobAnalysis.Description != "" {
		builder.WriteString("岗位描述：" + utils.CleanText(jobAnalysis.Description, 600) + "\n")
	}
	if strings.TrimSpace(deliveryStrategy.GreetingPrompt) != "" {
		builder.WriteString("开场白偏好：" + utils.CleanText(deliveryStrategy.GreetingPrompt, 300) + "\n")
	}
	builder.WriteString("岗位关键词：" + strings.Join(jobAnalysis.Keywords, "、") + "\n")
	if jobAnalysis.Recommendation != "" {
		builder.WriteString("岗位建议：" + jobAnalysis.Recommendation + "\n")
	}
	builder.WriteString("\n=== 求职目标 ===\n")
	builder.WriteString("主要求职方向：" + primaryTargetRole(deliveryStrategy) + "\n")
	builder.WriteString("目标城市：" + fixedTargetCity + "\n")
	if deliveryStrategy.MinSalaryK > 0 && deliveryStrategy.MaxSalaryK > 0 {
		builder.WriteString(fmt.Sprintf("期望月薪范围：%dK-%dK\n", deliveryStrategy.MinSalaryK, deliveryStrategy.MaxSalaryK))
	} else if deliveryStrategy.MinSalaryK > 0 {
		builder.WriteString(fmt.Sprintf("期望月薪不低于：%dK\n", deliveryStrategy.MinSalaryK))
	} else if deliveryStrategy.MaxSalaryK > 0 {
		builder.WriteString(fmt.Sprintf("期望月薪不高于：%dK\n", deliveryStrategy.MaxSalaryK))
	}
	builder.WriteString("对话目标：优先推进到简历审核、电话沟通或面试安排。\n")

	// 2. 候选人简历信息
	if resumePointer != nil {
		builder.WriteString("\n=== 候选人信息 ===\n")
		builder.WriteString("姓名：" + resumePointer.Profile.Name + "\n")
		if resumePointer.Profile.TargetRole != "" {
			builder.WriteString("求职意向：" + resumePointer.Profile.TargetRole + "\n")
		}
		if resumePointer.Profile.Location != "" {
			builder.WriteString("所在城市：" + resumePointer.Profile.Location + "\n")
		}
		builder.WriteString("简历摘要：\n" + sanitizeResumeForChatPrompt(resumePointer.Markdown) + "\n")
	}

	// 3. 对话上下文（传递更多历史，帮助 AI 理解对话走向）
	builder.WriteString("\n=== 对话上下文 ===\n")
	builder.WriteString("沟通语气：" + mode + "\n")

	// 统计对话轮次和最近交互模式
	recruiterCount := 0
	candidateCount := 0
	for _, msg := range messages {
		if strings.EqualFold(msg.Role, "recruiter") {
			recruiterCount++
		} else {
			candidateCount++
		}
	}
	builder.WriteString(fmt.Sprintf("对话轮次：HR 已发 %d 条，候选人已发 %d 条\n", recruiterCount, candidateCount))

	pendingMessages := pendingRecruiterMessages(messages)
	if len(pendingMessages) > 0 {
		builder.WriteString("本轮必须逐项处理的 HR 消息：\n")
		for index, message := range pendingMessages {
			builder.WriteString(fmt.Sprintf("  HR待答%d：%s\n", index+1, message))
		}
		builder.WriteString("以上每条中的问题、编号项和要求都必须回答，不得只回复最后一条。\n")
	}

	// 分析 HR 最近的回复风格
	if recruiterCount > 0 {
		recentRecruiterMsgs := make([]string, 0)
		for _, msg := range messages {
			if strings.EqualFold(msg.Role, "recruiter") && strings.TrimSpace(msg.Content) != "" {
				recentRecruiterMsgs = append(recentRecruiterMsgs, msg.Content)
			}
		}
		// 取最近3条HR消息分析风格
		analysisStart := 0
		if len(recentRecruiterMsgs) > 3 {
			analysisStart = len(recentRecruiterMsgs) - 3
		}
		if len(recentRecruiterMsgs) > 0 {
			builder.WriteString("HR 最近回复风格参考：\n")
			for _, msg := range recentRecruiterMsgs[analysisStart:] {
				builder.WriteString("  - " + utils.CleanText(msg, 200) + "\n")
			}
		}
	}

	// 传递当前页面能读取到的完整聊天历史，兼顾上下文和模型输入长度。
	builder.WriteString("\n=== 完整对话记录 ===\n")
	// 保留最近80条，避免HR连续多条提问被较短窗口截断。
	startIndex := 0
	if len(messages) > 80 {
		startIndex = len(messages) - 80
		// 如果截断了，提示AI前面还有历史
		builder.WriteString("（前面还有 " + fmt.Sprintf("%d", startIndex) + " 条历史消息）\n")
	}
	for _, message := range messages[startIndex:] {
		roleLabel := "HR"
		if !strings.EqualFold(message.Role, "recruiter") {
			roleLabel = "候选人"
		}
		builder.WriteString(roleLabel + "：" + utils.CleanText(message.Content, 300) + "\n")
	}

	// 4. 生成指导
	builder.WriteString("\n=== 生成要求 ===\n")
	builder.WriteString("请基于以上上下文，生成候选人的下一句回复。\n")
	builder.WriteString("要求：\n")
	builder.WriteString("1. 回复必须承接本轮全部待答 HR 消息，不能遗漏前一条、只回复最后一条或自言自语\n")
	builder.WriteString("2. 回复必须与候选人简历中的真实经验和技能一致\n")
	builder.WriteString("3. 回复语气必须符合「" + mode + "」风格\n")
	builder.WriteString("4. HR连续发来多条消息或一条消息包含多个、编号问题时，必须按出现顺序逐项正面回答所有问题和要求\n")
	builder.WriteString("5. 从岗位要求和简历中挑出最相关的1到2个匹配点，并主动推动发简历、电话或面试\n")
	builder.WriteString("6. 薪资低于目标范围时询问预算是否可谈；明显不匹配时询问是否有相近岗位\n")
	builder.WriteString("7. 使用真诚、尊重、有分寸的求职者口吻，对HR提供的信息、时间或沟通机会自然表达感谢，并对贵司和岗位保持尊重\n")
	builder.WriteString("8. 感谢必须贴合当轮语境，每条最多一次；不要机械重复感谢贵司，不要奉承、卑微、客服腔或公文腔\n")
	builder.WriteString("9. 用一条自然回复覆盖本轮全部待答内容；HR索要简历时礼貌感谢并简短确认已经发送\n")
	builder.WriteString("10. 通常20到100字，一段话，可直接发送；问题较多时以完整回答为先\n")

	return builder.String()
}

// pendingRecruiterMessages 返回候选人上次发言后 HR 连续发来的全部非空消息。
func pendingRecruiterMessages(messages []domain.Message) []string {
	lastCandidateIndex := -1
	for index, message := range messages {
		if strings.EqualFold(strings.TrimSpace(message.Role), "candidate") {
			lastCandidateIndex = index
		}
	}

	pendingMessages := make([]string, 0)
	for _, message := range messages[lastCandidateIndex+1:] {
		if !strings.EqualFold(strings.TrimSpace(message.Role), "recruiter") {
			continue
		}
		content := utils.CleanText(message.Content, 300)
		if content != "" {
			pendingMessages = append(pendingMessages, content)
		}
	}
	return pendingMessages
}

var chatPromptSensitiveLinePattern = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|authorization|credential)\s*[:=：]`)

// 聊天模型只需要履历事实；配置文件中误混入的口令、令牌和密钥行不得进入模型提示。
func sanitizeResumeForChatPrompt(markdown string) string {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	safeLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if chatPromptSensitiveLinePattern.MatchString(line) {
			continue
		}
		safeLines = append(safeLines, line)
	}
	return utils.CleanText(strings.Join(safeLines, "\n"), 3000)
}

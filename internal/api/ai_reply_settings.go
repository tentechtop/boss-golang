package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"boss-job-assistant/internal/domain"
)

const (
	aiReplyProviderCodex    = "codex"
	aiReplyProviderDeepSeek = "deepseek"
	aiReplyProviderZhipu    = "zhipu"
	aiReplyFallbackTemplate = "template"
	aiReplyFallbackDeepSeek = "deepseek"
	deepSeekModelV4Flash    = "deepseek-v4-flash"
	deepSeekModelV4Pro      = "deepseek-v4-pro"
	zhipuModelGLM47Flash    = "glm-4.7-flash"
	zhipuModelGLM47         = "glm-4.7"
	zhipuModelGLM52         = "glm-5.2"
)

type saveAIReplySettingsRequest struct {
	Provider       string `json:"provider"`
	FallbackMode   string `json:"fallbackMode"`
	DeepSeekModel  string `json:"deepSeekModel"`
	DeepSeekAPIKey string `json:"deepSeekApiKey"`
	ZhipuModel     string `json:"zhipuModel"`
	ZhipuAPIKey    string `json:"zhipuApiKey"`
}

type aiReplySettingsView struct {
	Provider                 string    `json:"provider"`
	FallbackMode             string    `json:"fallbackMode"`
	DeepSeekModel            string    `json:"deepSeekModel"`
	DeepSeekAPIKeyConfigured bool      `json:"deepSeekApiKeyConfigured"`
	ZhipuModel               string    `json:"zhipuModel"`
	ZhipuAPIKeyConfigured    bool      `json:"zhipuApiKeyConfigured"`
	UpdatedAt                time.Time `json:"updatedAt"`
}

type codexAvailabilityView struct {
	Configured bool   `json:"configured"`
	Available  bool   `json:"available"`
	Message    string `json:"message"`
}

func (server *Server) handleGetAIReplySettings(responseWriter http.ResponseWriter, request *http.Request) {
	server.writeAIReplySettingsResponse(responseWriter, request.Context(), http.StatusOK)
}

func (server *Server) handleSaveAIReplySettings(responseWriter http.ResponseWriter, request *http.Request) {
	var payload saveAIReplySettingsRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	provider := resolveRequestedAIReplyProvider(payload.Provider, payload.FallbackMode)
	if !isSupportedAIReplyProvider(provider) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("回复模型来源不合法"))
		return
	}

	currentSettings := server.normalizedAIReplySettings()
	deepSeekModel := strings.TrimSpace(payload.DeepSeekModel)
	if deepSeekModel == "" {
		deepSeekModel = currentSettings.DeepSeekModel
	}
	if !isSupportedDeepSeekModel(deepSeekModel) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("不支持的 DeepSeek 模型"))
		return
	}
	zhipuModel := strings.TrimSpace(payload.ZhipuModel)
	if zhipuModel == "" {
		zhipuModel = currentSettings.ZhipuModel
	}
	if !isSupportedZhipuModel(zhipuModel) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("不支持的智谱模型"))
		return
	}

	deepSeekAPIKey := strings.TrimSpace(payload.DeepSeekAPIKey)
	if deepSeekAPIKey == "" {
		deepSeekAPIKey = currentSettings.DeepSeekAPIKey
	}
	if len(deepSeekAPIKey) > 512 {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("DeepSeek API Key 长度不能超过 512 个字符"))
		return
	}
	zhipuAPIKey := strings.TrimSpace(payload.ZhipuAPIKey)
	if zhipuAPIKey == "" {
		zhipuAPIKey = currentSettings.ZhipuAPIKey
	}
	if len(zhipuAPIKey) > 512 {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("智谱 API Key 长度不能超过 512 个字符"))
		return
	}

	settings := domain.AIReplySettings{
		Provider:       provider,
		FallbackMode:   legacyFallbackMode(provider),
		DeepSeekModel:  deepSeekModel,
		DeepSeekAPIKey: deepSeekAPIKey,
		ZhipuModel:     zhipuModel,
		ZhipuAPIKey:    zhipuAPIKey,
		UpdatedAt:      time.Now(),
	}
	if provider == aiReplyProviderDeepSeek && !server.deepSeekConfigured(settings) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("选择 DeepSeek 前必须填写 API Key"))
		return
	}
	if provider == aiReplyProviderZhipu && !server.zhipuConfigured(settings) {
		writeError(responseWriter, http.StatusBadRequest, fmt.Errorf("选择智谱前必须填写 API Key"))
		return
	}
	if saveErr := server.store.SaveAIReplySettings(settings); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	server.writeAIReplySettingsResponse(responseWriter, request.Context(), http.StatusOK)
}

func (server *Server) writeAIReplySettingsResponse(responseWriter http.ResponseWriter, ctx context.Context, statusCode int) {
	settings := server.normalizedAIReplySettings()
	writeJSON(responseWriter, statusCode, map[string]any{
		"settings": aiReplySettingsView{
			Provider:                 settings.Provider,
			FallbackMode:             settings.FallbackMode,
			DeepSeekModel:            settings.DeepSeekModel,
			DeepSeekAPIKeyConfigured: server.deepSeekConfigured(settings),
			ZhipuModel:               settings.ZhipuModel,
			ZhipuAPIKeyConfigured:    server.zhipuConfigured(settings),
			UpdatedAt:                settings.UpdatedAt,
		},
		"codex": server.codexAvailability(ctx),
		"deepSeekModels": []map[string]string{
			{"value": deepSeekModelV4Flash, "label": "DeepSeek V4 Flash（速度优先）"},
			{"value": deepSeekModelV4Pro, "label": "DeepSeek V4 Pro（效果优先）"},
		},
		"zhipuModels": []map[string]string{
			{"value": zhipuModelGLM47Flash, "label": "GLM-4.7-Flash（免费）"},
			{"value": zhipuModelGLM47, "label": "GLM-4.7（效果优先）"},
			{"value": zhipuModelGLM52, "label": "GLM-5.2（旗舰）"},
		},
	})
}

func (server *Server) normalizedAIReplySettings() domain.AIReplySettings {
	settings := server.store.GetAIReplySettings()
	settings.DeepSeekAPIKey = strings.TrimSpace(settings.DeepSeekAPIKey)
	settings.ZhipuAPIKey = strings.TrimSpace(settings.ZhipuAPIKey)
	if !isSupportedAIReplyProvider(settings.Provider) {
		if settings.FallbackMode == aiReplyFallbackDeepSeek && server.deepSeekConfigured(settings) {
			settings.Provider = aiReplyProviderDeepSeek
		} else {
			settings.Provider = aiReplyProviderCodex
		}
	}
	settings.FallbackMode = legacyFallbackMode(settings.Provider)
	if !isSupportedDeepSeekModel(settings.DeepSeekModel) {
		settings.DeepSeekModel = server.defaultDeepSeekModel
	}
	if !isSupportedDeepSeekModel(settings.DeepSeekModel) {
		settings.DeepSeekModel = deepSeekModelV4Flash
	}
	if !isSupportedZhipuModel(settings.ZhipuModel) {
		settings.ZhipuModel = server.defaultZhipuModel
	}
	if !isSupportedZhipuModel(settings.ZhipuModel) {
		settings.ZhipuModel = zhipuModelGLM47Flash
	}
	return settings
}

func resolveRequestedAIReplyProvider(provider string, fallbackMode string) string {
	cleanProvider := strings.TrimSpace(provider)
	if cleanProvider != "" {
		return cleanProvider
	}
	if strings.TrimSpace(fallbackMode) == aiReplyFallbackDeepSeek {
		return aiReplyProviderDeepSeek
	}
	if strings.TrimSpace(fallbackMode) == aiReplyFallbackTemplate {
		return aiReplyProviderCodex
	}
	return ""
}

func legacyFallbackMode(provider string) string {
	if provider == aiReplyProviderDeepSeek {
		return aiReplyFallbackDeepSeek
	}
	return aiReplyFallbackTemplate
}

func isSupportedAIReplyProvider(provider string) bool {
	return provider == aiReplyProviderCodex || provider == aiReplyProviderDeepSeek || provider == aiReplyProviderZhipu
}

func (server *Server) deepSeekConfigured(settings domain.AIReplySettings) bool {
	if strings.TrimSpace(settings.DeepSeekAPIKey) != "" || strings.TrimSpace(server.deepSeekAPIKey) != "" {
		return true
	}
	return server.aiClient != nil && server.aiClient.Configured()
}

func (server *Server) deepSeekClient(settings domain.AIReplySettings) ChatCompletionClient {
	apiKey := strings.TrimSpace(settings.DeepSeekAPIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(server.deepSeekAPIKey)
	}
	if apiKey != "" && server.deepSeekClientFactory != nil {
		return server.deepSeekClientFactory(apiKey, settings.DeepSeekModel)
	}
	return server.aiClient
}

func (server *Server) zhipuConfigured(settings domain.AIReplySettings) bool {
	if strings.TrimSpace(settings.ZhipuAPIKey) != "" || strings.TrimSpace(server.zhipuAPIKey) != "" {
		return true
	}
	return server.zhipuClient != nil && server.zhipuClient.Configured()
}

func (server *Server) zhipuCompletionClient(settings domain.AIReplySettings) ChatCompletionClient {
	apiKey := strings.TrimSpace(settings.ZhipuAPIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(server.zhipuAPIKey)
	}
	if apiKey != "" && server.zhipuClientFactory != nil {
		return server.zhipuClientFactory(apiKey, settings.ZhipuModel)
	}
	return server.zhipuClient
}

func (server *Server) codexAvailability(ctx context.Context) codexAvailabilityView {
	if server.codexClient == nil || !server.codexClient.Configured() {
		return codexAvailabilityView{Message: "未找到可用的 Codex CLI"}
	}
	checker, supportsCheck := server.codexClient.(availabilityChecker)
	if !supportsCheck {
		return codexAvailabilityView{Configured: true, Available: true, Message: "Codex 已配置"}
	}
	if checkErr := checker.CheckAvailability(ctx); checkErr != nil {
		return codexAvailabilityView{Configured: true, Message: "Codex CLI 未登录或当前无法使用"}
	}
	return codexAvailabilityView{Configured: true, Available: true, Message: "Codex 当前可用"}
}

func isSupportedDeepSeekModel(model string) bool {
	return model == deepSeekModelV4Flash || model == deepSeekModelV4Pro
}

func isSupportedZhipuModel(model string) bool {
	return model == zhipuModelGLM47Flash || model == zhipuModelGLM47 || model == zhipuModelGLM52
}

func useLocalRuleReply(suggestion domain.ChatSuggestion) domain.ChatSuggestion {
	suggestion.AlternativeReplies = nil
	suggestion.Generator = "fixed_template"
	suggestion.Reasons = append([]string{"AI 模型不可用，已根据岗位和简历使用本地规则生成回复"}, suggestion.Reasons...)
	return suggestion
}

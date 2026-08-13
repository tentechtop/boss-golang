package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"boss-job-assistant/internal/domain"
)

type testChatCompletionClient struct {
	configured     bool
	completion     string
	err            error
	completeCalled bool
}

type unavailableCodexClient struct {
	completeCalled bool
}

func (client *unavailableCodexClient) Configured() bool {
	return true
}

func (client *unavailableCodexClient) CheckAvailability(context.Context) error {
	return errors.New("not logged in")
}

func (client *unavailableCodexClient) Complete(context.Context, string, string) (string, error) {
	client.completeCalled = true
	return "", errors.New("must not be called")
}

func (client *testChatCompletionClient) Configured() bool {
	return client != nil && client.configured
}

func (client *testChatCompletionClient) Complete(context.Context, string, string) (string, error) {
	client.completeCalled = true
	return client.completion, client.err
}

func TestSaveAIReplySettingsRequiresAPIKeyForDeepSeek(t *testing.T) {
	server, _ := newAutoChatStatusTestServer(t)
	response := performAIReplySettingsRequest(t, server, map[string]string{
		"provider":      aiReplyProviderDeepSeek,
		"deepSeekModel": deepSeekModelV4Flash,
		"zhipuModel":    zhipuModelGLM47Flash,
	})

	if response.Code != http.StatusBadRequest {
		t.Fatalf("未填写 DeepSeek API Key 时状态码错误: got=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "必须填写 API Key") {
		t.Fatalf("未填写 DeepSeek API Key 时错误信息不明确: %s", response.Body.String())
	}
}

func TestSaveAIReplySettingsRequiresAPIKeyForZhipu(t *testing.T) {
	server, _ := newAutoChatStatusTestServer(t)
	response := performAIReplySettingsRequest(t, server, map[string]string{
		"provider":      aiReplyProviderZhipu,
		"deepSeekModel": deepSeekModelV4Flash,
		"zhipuModel":    zhipuModelGLM47Flash,
	})

	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "选择智谱前必须填写 API Key") {
		t.Fatalf("未填写智谱 API Key 时校验错误: code=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAIReplySettingsDoesNotReturnStoredAPIKey(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	deepSeekSecret := "sk-deepseek-secret-for-test"
	zhipuSecret := "zhipu-secret-for-test"
	response := performAIReplySettingsRequest(t, server, map[string]string{
		"provider":       aiReplyProviderZhipu,
		"deepSeekModel":  deepSeekModelV4Pro,
		"deepSeekApiKey": deepSeekSecret,
		"zhipuModel":     zhipuModelGLM52,
		"zhipuApiKey":    zhipuSecret,
	})

	if response.Code != http.StatusOK {
		t.Fatalf("保存 AI 回复设置失败: code=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), deepSeekSecret) || strings.Contains(response.Body.String(), zhipuSecret) {
		t.Fatalf("AI 回复设置接口不应回显 API Key: %s", response.Body.String())
	}
	for _, expected := range []string{`"deepSeekApiKeyConfigured":true`, `"zhipuApiKeyConfigured":true`, `"provider":"zhipu"`} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("AI 回复设置接口缺少配置状态 %s: %s", expected, response.Body.String())
		}
	}
	if stored := store.GetAIReplySettings(); stored.DeepSeekAPIKey != deepSeekSecret || stored.ZhipuAPIKey != zhipuSecret || stored.ZhipuModel != zhipuModelGLM52 {
		t.Fatalf("AI 回复设置未正确保存: %#v", stored)
	}
}

func TestBuildChatSuggestionUsesJobAndResumeLocalRuleWhenCodexFails(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	codexClient := &unavailableCodexClient{}
	server.codexClient = codexClient
	if saveErr := store.SaveAIReplySettings(domain.AIReplySettings{
		Provider:      aiReplyProviderCodex,
		FallbackMode:  aiReplyFallbackTemplate,
		DeepSeekModel: deepSeekModelV4Flash,
	}); saveErr != nil {
		t.Fatal(saveErr)
	}

	suggestion, suggestErr := server.buildChatSuggestion(
		httptest.NewRequest(http.MethodPost, "/api/chat/auto/reply", nil),
		domain.JobAnalysis{Title: "Golang 后端工程师", Keywords: []string{"Go", "MySQL"}},
		&domain.ResumeVersion{Profile: domain.CandidateProfile{TargetRole: "Go 后端", Skills: []string{"Go"}}},
		nil,
		"积极主动",
	)
	if suggestErr != nil {
		t.Fatal(suggestErr)
	}
	if suggestion.Generator != "fixed_template" {
		t.Fatalf("Codex 失败后未使用本地规则: %#v", suggestion)
	}
	for _, expected := range []string{"Golang 后端工程师", "Go", "简历技能"} {
		if !strings.Contains(suggestion.RecommendedReply, expected) {
			t.Fatalf("本地规则回复缺少岗位或简历事实 %q: %s", expected, suggestion.RecommendedReply)
		}
	}
	if strings.Contains(suggestion.RecommendedReply, "MySQL") {
		t.Fatalf("本地规则不应声称简历包含未填写的技能: %s", suggestion.RecommendedReply)
	}
	if codexClient.completeCalled {
		t.Fatalf("Codex 可用性检查失败后不应继续执行模型请求")
	}
}

func TestBuildChatSuggestionUsesSelectedLocalCodex(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	codexClient := &testChatCompletionClient{configured: true, completion: "您好，我对这个岗位很感兴趣，希望进一步沟通。"}
	server.codexClient = codexClient
	server.deepSeekClientFactory = func(string, string) ChatCompletionClient {
		t.Fatalf("明确选择本地 Codex 后不应调用 DeepSeek")
		return nil
	}
	server.zhipuClientFactory = func(string, string) ChatCompletionClient {
		t.Fatalf("明确选择本地 Codex 后不应调用智谱")
		return nil
	}
	if saveErr := store.SaveAIReplySettings(domain.AIReplySettings{Provider: aiReplyProviderCodex}); saveErr != nil {
		t.Fatal(saveErr)
	}

	suggestion, suggestErr := server.buildChatSuggestion(
		httptest.NewRequest(http.MethodPost, "/api/chat/auto/reply", nil),
		domain.JobAnalysis{Title: "Golang 后端工程师"},
		&domain.ResumeVersion{},
		nil,
		"积极主动",
	)
	if suggestErr != nil {
		t.Fatal(suggestErr)
	}
	if suggestion.Generator != "codex" || !codexClient.completeCalled {
		t.Fatalf("未使用用户选择的本地 Codex: %#v", suggestion)
	}
}

func TestNormalizeAIReplySettingsMigratesLegacyDeepSeekChoice(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	if saveErr := store.SaveAIReplySettings(domain.AIReplySettings{
		FallbackMode:   aiReplyFallbackDeepSeek,
		DeepSeekModel:  deepSeekModelV4Pro,
		DeepSeekAPIKey: "legacy-deepseek-key",
	}); saveErr != nil {
		t.Fatal(saveErr)
	}

	settings := server.normalizedAIReplySettings()
	if settings.Provider != aiReplyProviderDeepSeek || settings.DeepSeekModel != deepSeekModelV4Pro {
		t.Fatalf("旧 DeepSeek 配置迁移错误: %#v", settings)
	}
}

func TestPrepareResumeForQueueRequiresExistingResume(t *testing.T) {
	server, _ := newAutoChatStatusTestServer(t)

	if _, prepareErr := server.prepareResumeForQueue(domain.JobAnalysis{}, ""); prepareErr == nil || !strings.Contains(prepareErr.Error(), "必须先导入或生成有效简历") {
		t.Fatalf("无简历时不应继续主动联系 HR: %v", prepareErr)
	}
	if _, prepareErr := server.prepareResumeForQueue(domain.JobAnalysis{}, "resume_missing"); prepareErr == nil || !strings.Contains(prepareErr.Error(), "简历不存在") {
		t.Fatalf("选择不存在的简历时错误不明确: %v", prepareErr)
	}
}

func TestBuildChatSuggestionUsesSelectedDeepSeekModel(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	codexClient := &testChatCompletionClient{configured: true, completion: "不应调用 Codex"}
	server.codexClient = codexClient
	var receivedAPIKey string
	var receivedModel string
	server.deepSeekClientFactory = func(apiKey string, model string) ChatCompletionClient {
		receivedAPIKey = apiKey
		receivedModel = model
		return &testChatCompletionClient{configured: true, completion: "感谢您的回复，我对岗位很感兴趣，方便进一步沟通。"}
	}
	if saveErr := store.SaveAIReplySettings(domain.AIReplySettings{
		Provider:       aiReplyProviderDeepSeek,
		FallbackMode:   aiReplyFallbackDeepSeek,
		DeepSeekModel:  deepSeekModelV4Pro,
		DeepSeekAPIKey: "sk-selected-model-test",
	}); saveErr != nil {
		t.Fatal(saveErr)
	}

	suggestion, suggestErr := server.buildChatSuggestion(
		httptest.NewRequest(http.MethodPost, "/api/chat/auto/reply", nil),
		domain.JobAnalysis{Title: "Golang 后端工程师"},
		&domain.ResumeVersion{},
		[]domain.Message{{Role: "recruiter", Content: "方便聊聊吗？"}},
		"积极主动",
	)
	if suggestErr != nil {
		t.Fatal(suggestErr)
	}
	if receivedAPIKey != "sk-selected-model-test" || receivedModel != deepSeekModelV4Pro {
		t.Fatalf("DeepSeek 客户端配置错误: key=%q model=%q", receivedAPIKey, receivedModel)
	}
	if suggestion.Generator != "deepseek" {
		t.Fatalf("未使用 DeepSeek 回复: %#v", suggestion)
	}
	if codexClient.completeCalled {
		t.Fatalf("明确选择 DeepSeek 后不应先调用 Codex")
	}
}

func TestBuildChatSuggestionUsesSelectedZhipuModel(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	codexClient := &testChatCompletionClient{configured: true, completion: "不应调用 Codex"}
	server.codexClient = codexClient
	var receivedAPIKey string
	var receivedModel string
	server.zhipuClientFactory = func(apiKey string, model string) ChatCompletionClient {
		receivedAPIKey = apiKey
		receivedModel = model
		return &testChatCompletionClient{configured: true, completion: "您好，我的 Go 后端经历与岗位匹配，希望进一步沟通。"}
	}
	if saveErr := store.SaveAIReplySettings(domain.AIReplySettings{
		Provider:    aiReplyProviderZhipu,
		ZhipuModel:  zhipuModelGLM47Flash,
		ZhipuAPIKey: "zhipu-selected-model-test",
	}); saveErr != nil {
		t.Fatal(saveErr)
	}

	suggestion, suggestErr := server.buildChatSuggestion(
		httptest.NewRequest(http.MethodPost, "/api/chat/auto/reply", nil),
		domain.JobAnalysis{Title: "Golang 后端工程师"},
		&domain.ResumeVersion{},
		nil,
		"积极主动",
	)
	if suggestErr != nil {
		t.Fatal(suggestErr)
	}
	if receivedAPIKey != "zhipu-selected-model-test" || receivedModel != zhipuModelGLM47Flash {
		t.Fatalf("智谱客户端配置错误: key=%q model=%q", receivedAPIKey, receivedModel)
	}
	if suggestion.Generator != "zhipu" {
		t.Fatalf("未使用智谱回复: %#v", suggestion)
	}
	if codexClient.completeCalled {
		t.Fatalf("明确选择智谱后不应先调用 Codex")
	}
}

func performAIReplySettingsRequest(t *testing.T, server *Server, payload any) *httptest.ResponseRecorder {
	t.Helper()
	requestBody, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/ai/reply-settings", bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	return response
}

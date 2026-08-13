package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCompatibleChatClientUsesConfiguredProviderEndpointAndModel(t *testing.T) {
	var receivedModel string
	server := httptest.NewServer(http.HandlerFunc(func(responseWriter http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/paas/v4/chat/completions" {
			t.Fatalf("请求路径错误: %s", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer test-api-key" {
			t.Fatalf("鉴权头错误")
		}
		var payload chatRequest
		if decodeErr := json.NewDecoder(request.Body).Decode(&payload); decodeErr != nil {
			t.Fatal(decodeErr)
		}
		receivedModel = payload.Model
		responseWriter.Header().Set("Content-Type", "application/json")
		_, _ = responseWriter.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"智谱回复"}}]}`))
	}))
	defer server.Close()

	client := NewCompatibleChatClient(CompatibleChatConfig{
		ProviderName: "智谱 GLM",
		APIKey:       "test-api-key",
		BaseURL:      server.URL + "/api/paas/v4",
		Model:        "glm-4.7-flash",
		Timeout:      time.Second,
	})
	completion, completeErr := client.Complete(context.Background(), "系统提示", "用户提示")
	if completeErr != nil {
		t.Fatal(completeErr)
	}
	if completion != "智谱回复" || receivedModel != "glm-4.7-flash" {
		t.Fatalf("兼容模型调用结果错误: completion=%q model=%q", completion, receivedModel)
	}
}

func TestCompatibleChatClientUsesProviderNameInConfigurationError(t *testing.T) {
	client := NewCompatibleChatClient(CompatibleChatConfig{ProviderName: "智谱 GLM"})
	_, completeErr := client.Complete(context.Background(), "", "")
	if completeErr == nil || !strings.Contains(completeErr.Error(), "智谱 GLM API Key") {
		t.Fatalf("缺少密钥时错误未标识模型提供方: %v", completeErr)
	}
}

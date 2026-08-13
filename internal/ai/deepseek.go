package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type CompatibleChatConfig struct {
	ProviderName string
	APIKey       string
	BaseURL      string
	Model        string
	Timeout      time.Duration
}

type CompatibleChatClient struct {
	providerName string
	apiKey       string
	baseURL      string
	model        string
	httpClient   *http.Client
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func NewCompatibleChatClient(config CompatibleChatConfig) *CompatibleChatClient {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}

	return &CompatibleChatClient{
		providerName: defaultProviderName(config.ProviderName),
		apiKey:       strings.TrimSpace(config.APIKey),
		baseURL:      strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"),
		model:        strings.TrimSpace(config.Model),
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (client *CompatibleChatClient) Configured() bool {
	return client != nil && client.apiKey != ""
}

func (client *CompatibleChatClient) Complete(ctx context.Context, systemPrompt string, userPrompt string) (string, error) {
	if client == nil || client.apiKey == "" {
		return "", fmt.Errorf("未配置%s API Key", client.providerName)
	}
	if strings.TrimSpace(client.baseURL) == "" {
		return "", fmt.Errorf("%s BaseURL 不能为空", client.providerName)
	}
	if strings.TrimSpace(client.model) == "" {
		return "", fmt.Errorf("%s Model 不能为空", client.providerName)
	}

	requestBody := chatRequest{
		Model: client.model,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Temperature: 0.3,
	}

	encodedBody, marshalErr := json.Marshal(requestBody)
	if marshalErr != nil {
		return "", fmt.Errorf("编码%s请求失败: %w", client.providerName, marshalErr)
	}

	request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/chat/completions", bytes.NewReader(encodedBody))
	if requestErr != nil {
		return "", fmt.Errorf("创建%s请求失败: %w", client.providerName, requestErr)
	}
	request.Header.Set("Authorization", "Bearer "+client.apiKey)
	request.Header.Set("Content-Type", "application/json")

	response, doErr := client.httpClient.Do(request)
	if doErr != nil {
		return "", fmt.Errorf("调用%s失败: %w", client.providerName, doErr)
	}
	defer response.Body.Close()

	var decodedResponse chatResponse
	if decodeErr := json.NewDecoder(response.Body).Decode(&decodedResponse); decodeErr != nil {
		return "", fmt.Errorf("解析%s响应失败: %w", client.providerName, decodeErr)
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		errorMessage := response.Status
		if decodedResponse.Error != nil && strings.TrimSpace(decodedResponse.Error.Message) != "" {
			errorMessage = decodedResponse.Error.Message
		}
		return "", fmt.Errorf("%s返回异常状态: %s", client.providerName, errorMessage)
	}

	if len(decodedResponse.Choices) == 0 {
		return "", fmt.Errorf("%s响应缺少候选内容", client.providerName)
	}

	content := strings.TrimSpace(decodedResponse.Choices[0].Message.Content)
	if content == "" {
		return "", fmt.Errorf("%s响应内容为空", client.providerName)
	}

	return content, nil
}

// 兼容旧调用方；新模型提供方统一使用 NewCompatibleChatClient。
type DeepSeekConfig = CompatibleChatConfig
type DeepSeekClient = CompatibleChatClient

func NewDeepSeekClient(config DeepSeekConfig) *DeepSeekClient {
	return NewCompatibleChatClient(config)
}

func defaultProviderName(providerName string) string {
	cleanProviderName := strings.TrimSpace(providerName)
	if cleanProviderName == "" {
		return "DeepSeek"
	}
	return cleanProviderName
}

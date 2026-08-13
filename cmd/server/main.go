package main

import (
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"time"

	"boss-job-assistant/internal/ai"
	"boss-job-assistant/internal/api"
	"boss-job-assistant/internal/config"
	"boss-job-assistant/internal/database"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	appConfig := config.Load()
	if appConfig.MemoryLimit > 0 {
		debug.SetMemoryLimit(appConfig.MemoryLimit)
		logger.Info("运行时内存上限已设置", "bytes", appConfig.MemoryLimit)
	}
	store, storeErr := database.Open(appConfig.DataFilePath)
	if storeErr != nil {
		logger.Error("数据存储初始化失败", "error", storeErr)
		os.Exit(1)
	}
	defer func() {
		if closeErr := store.Close(); closeErr != nil {
			logger.Error("数据存储关闭失败", "error", closeErr)
		}
	}()

	deepSeekClient := ai.NewCompatibleChatClient(ai.CompatibleChatConfig{
		ProviderName: "DeepSeek",
		APIKey:       appConfig.DeepSeekAPIKey,
		BaseURL:      appConfig.DeepSeekBaseURL,
		Model:        appConfig.DeepSeekModel,
		Timeout:      45 * time.Second,
	})
	zhipuClient := ai.NewCompatibleChatClient(ai.CompatibleChatConfig{
		ProviderName: "智谱 GLM",
		APIKey:       appConfig.ZhipuAPIKey,
		BaseURL:      appConfig.ZhipuBaseURL,
		Model:        appConfig.ZhipuModel,
		Timeout:      45 * time.Second,
	})
	codexClient := ai.NewCodexClient(ai.CodexConfig{
		Command: appConfig.CodexCommand,
		Model:   appConfig.CodexModel,
		WorkDir: appConfig.CodexWorkDir,
		Timeout: time.Duration(appConfig.CodexTimeoutSec) * time.Second,
	})

	server := api.NewServer(api.ServerConfig{
		Store:                store,
		AIClient:             deepSeekClient,
		CodexClient:          codexClient,
		DeepSeekAPIKey:       appConfig.DeepSeekAPIKey,
		DefaultDeepSeekModel: appConfig.DeepSeekModel,
		ZhipuClient:          zhipuClient,
		ZhipuAPIKey:          appConfig.ZhipuAPIKey,
		DefaultZhipuModel:    appConfig.ZhipuModel,
		DeepSeekClientFactory: func(apiKey string, model string) api.ChatCompletionClient {
			return ai.NewCompatibleChatClient(ai.CompatibleChatConfig{
				ProviderName: "DeepSeek",
				APIKey:       apiKey,
				BaseURL:      appConfig.DeepSeekBaseURL,
				Model:        model,
				Timeout:      45 * time.Second,
			})
		},
		ZhipuClientFactory: func(apiKey string, model string) api.ChatCompletionClient {
			return ai.NewCompatibleChatClient(ai.CompatibleChatConfig{
				ProviderName: "智谱 GLM",
				APIKey:       apiKey,
				BaseURL:      appConfig.ZhipuBaseURL,
				Model:        model,
				Timeout:      45 * time.Second,
			})
		},
		StaticDir:      appConfig.StaticDir,
		MaxRequestSize: appConfig.MaxRequestSize,
		Logger:         logger,
	})

	httpServer := &http.Server{
		Addr:              appConfig.Address,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	logger.Info("服务已启动", "address", appConfig.Address, "data", appConfig.DataFilePath)
	if serveErr := httpServer.ListenAndServe(); serveErr != nil && serveErr != http.ErrServerClosed {
		logger.Error("服务启动失败", "error", serveErr)
		os.Exit(1)
	}
}

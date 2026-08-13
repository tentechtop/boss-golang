package config

import (
	"os"
	"path/filepath"
	"strconv"
)

const (
	defaultAddress        = "127.0.0.1:8083"
	defaultDataDirectory  = "data"
	defaultDataFileName   = "app-data.json"
	defaultStaticDir      = "web"
	defaultDeepSeekBase   = "https://api.deepseek.com"
	defaultDeepSeekModel  = "deepseek-v4-flash"
	defaultZhipuBase      = "https://open.bigmodel.cn/api/paas/v4"
	defaultZhipuModel     = "glm-4.7-flash"
	defaultCodexCommand   = "codex"
	defaultCodexModel     = "gpt-5.6-sol"
	defaultCodexTimeout   = int64(75)
	defaultMemoryLimit    = int64(2 * 1024 * 1024 * 1024)
	defaultMaxRequestSize = int64(2 * 1024 * 1024)
)

type Config struct {
	Address         string
	DataFilePath    string
	StaticDir       string
	DeepSeekAPIKey  string
	DeepSeekBaseURL string
	DeepSeekModel   string
	ZhipuAPIKey     string
	ZhipuBaseURL    string
	ZhipuModel      string
	CodexCommand    string
	CodexModel      string
	CodexWorkDir    string
	CodexTimeoutSec int64
	MemoryLimit     int64
	MaxRequestSize  int64
}

func Load() Config {
	address := getEnv("APP_ADDR", defaultAddress)
	dataDirectory := getEnv("APP_DATA_DIR", defaultDataDirectory)
	dataFilePath := filepath.Join(dataDirectory, defaultDataFileName)
	maxRequestSize := parseInt64Env("APP_MAX_REQUEST_BYTES", defaultMaxRequestSize)

	return Config{
		Address:         address,
		DataFilePath:    dataFilePath,
		StaticDir:       getEnv("APP_STATIC_DIR", defaultStaticDir),
		DeepSeekAPIKey:  os.Getenv("DEEPSEEK_API_KEY"),
		DeepSeekBaseURL: getEnv("DEEPSEEK_BASE_URL", defaultDeepSeekBase),
		DeepSeekModel:   getEnv("DEEPSEEK_MODEL", defaultDeepSeekModel),
		ZhipuAPIKey:     os.Getenv("ZHIPU_API_KEY"),
		ZhipuBaseURL:    getEnv("ZHIPU_BASE_URL", defaultZhipuBase),
		ZhipuModel:      getEnv("ZHIPU_MODEL", defaultZhipuModel),
		CodexCommand:    getEnv("CODEX_COMMAND", defaultCodexCommand),
		CodexModel:      getEnv("CODEX_MODEL", defaultCodexModel),
		CodexWorkDir:    getEnv("CODEX_WORKDIR", os.TempDir()),
		CodexTimeoutSec: parseInt64Env("CODEX_TIMEOUT_SECONDS", defaultCodexTimeout),
		MemoryLimit:     parseInt64Env("APP_MEMORY_LIMIT_BYTES", defaultMemoryLimit),
		MaxRequestSize:  maxRequestSize,
	}
}

func getEnv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func parseInt64Env(key string, fallback int64) int64 {
	rawValue := os.Getenv(key)
	if rawValue == "" {
		return fallback
	}

	value, parseErr := strconv.ParseInt(rawValue, 10, 64)
	if parseErr != nil || value <= 0 {
		return fallback
	}
	return value
}

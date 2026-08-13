package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"boss-job-assistant/internal/database"
	"boss-job-assistant/internal/domain"
)

func TestHandleSaveAutomationControlStoresAndLaunches(t *testing.T) {
	server, store := newAutomationTestServer(t)
	launchCount := 0
	server.browserLaunchFunc = func() error {
		launchCount++
		return nil
	}

	requestBody := map[string]any{
		"enabled":             true,
		"resumeId":            "resume_1",
		"keyword":             "区块链",
		"city":                "深圳",
		"chatMode":            "积极主动",
		"scanIntervalMinutes": 5,
		"maxChatRounds":       10,
		"maxJobsPerScan":      20,
		"minMatchScore":       82,
		"launchBrowser":       true,
	}
	response := performAutomationJSONRequest(t, server.handleSaveAutomationControl, http.MethodPost, "/api/automation/control", requestBody)
	if response.Code != http.StatusOK {
		t.Fatalf("保存自动化控制失败: code=%d body=%s", response.Code, response.Body.String())
	}

	var payload struct {
		Control         domain.AutomationControl `json:"control"`
		LaunchedBrowser bool                     `json:"launchedBrowser"`
	}
	decodeAutomationResponse(t, response, &payload)

	if !payload.LaunchedBrowser {
		t.Fatalf("应返回已触发专用 Edge 启动")
	}
	if launchCount != 1 {
		t.Fatalf("专用 Edge 启动次数错误: got=%d want=1", launchCount)
	}
	if payload.Control.Revision <= 0 {
		t.Fatalf("自动化控制版本号未生成: %#v", payload.Control)
	}

	savedControl := store.GetAutomationControl()
	if !savedControl.Enabled || savedControl.Keyword != "区块链" || savedControl.City != fixedTargetCity {
		t.Fatalf("自动化控制保存错误: %#v", savedControl)
	}
	if savedControl.MinMatchScore != fixedMinMatchScore || savedControl.MaxJobsPerScan != defaultAutomationMaxJobsPerScan {
		t.Fatalf("自动化配置字段保存错误: %#v", savedControl)
	}
}

func TestHandleGetAutomationStatusIncludesCurrentQueueItem(t *testing.T) {
	server, store := newAutomationTestServer(t)
	queueItem := domain.DeliveryQueueItem{
		ID:        "queue_1",
		JobID:     "job_1",
		Title:     "Go 后端工程师",
		Company:   "示例科技",
		Location:  "深圳",
		Salary:    "25-35K",
		Status:    queueStatusOpened,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if saveErr := store.SaveQueueItems([]domain.DeliveryQueueItem{queueItem}); saveErr != nil {
		t.Fatalf("保存队列项失败: %v", saveErr)
	}

	statusRequest := map[string]any{
		"bridgeConnected":    true,
		"extensionVersion":   "0.3.7",
		"runtimeId":          "runtime_1",
		"surface":            "edge-extension",
		"desiredRevision":    10,
		"appliedRevision":    10,
		"enabled":            true,
		"phase":              "chatting",
		"currentQueueItemId": "queue_1",
		"currentJobId":       "job_1",
		"totalProcessed":     12,
		"totalChatted":       3,
		"currentRound":       1,
		"lastScanTime":       time.Now().UnixMilli(),
		"lastChatTime":       time.Now().UnixMilli(),
		"errors":             []string{"最近一轮成功"},
	}
	statusResponse := performAutomationJSONRequest(t, server.handleSaveAutomationStatus, http.MethodPost, "/api/automation/status", statusRequest)
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("保存自动化状态失败: code=%d body=%s", statusResponse.Code, statusResponse.Body.String())
	}

	getResponse := httptest.NewRecorder()
	server.handleGetAutomationStatus(getResponse, httptest.NewRequest(http.MethodGet, "/api/automation/status", nil))
	if getResponse.Code != http.StatusOK {
		t.Fatalf("获取自动化状态失败: code=%d body=%s", getResponse.Code, getResponse.Body.String())
	}

	var payload struct {
		Status           domain.AutomationStatus   `json:"status"`
		CurrentQueueItem *domain.DeliveryQueueItem `json:"currentQueueItem"`
	}
	decodeAutomationResponse(t, getResponse, &payload)

	if !payload.Status.BridgeConnected || payload.Status.Phase != "chatting" {
		t.Fatalf("自动化状态返回错误: %#v", payload.Status)
	}
	if payload.CurrentQueueItem == nil || payload.CurrentQueueItem.ID != "queue_1" {
		t.Fatalf("当前队列项未返回: %#v", payload.CurrentQueueItem)
	}
}

func TestAutomationQueueSkipsJobsFromPreviousTargetRole(t *testing.T) {
	server, store := newAutomationTestServer(t)
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.IncludeTitleKeywords = []string{"区块链"}
	if saveErr := store.SaveDeliveryStrategy(deliveryStrategy); saveErr != nil {
		t.Fatalf("保存区块链投递策略失败: %v", saveErr)
	}

	now := time.Now()
	queueItems := []domain.DeliveryQueueItem{
		{
			ID:         "queue_go",
			JobID:      "job_go",
			Title:      "Golang 后端工程师",
			Company:    "示例科技",
			Salary:     "25-35K",
			URL:        "https://www.zhipin.com/job_detail/go.html",
			MatchScore: 80,
			Status:     queueStatusQueued,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
		{
			ID:         "queue_blockchain",
			JobID:      "job_blockchain",
			Title:      "区块链后端开发工程师",
			Company:    "示例科技",
			Salary:     "25-35K",
			URL:        "https://www.zhipin.com/job_detail/blockchain.html",
			MatchScore: 80,
			Status:     queueStatusQueued,
			CreatedAt:  now.Add(time.Second),
			UpdatedAt:  now.Add(time.Second),
		},
	}
	if saveErr := store.SaveQueueItems(queueItems); saveErr != nil {
		t.Fatalf("保存测试队列失败: %v", saveErr)
	}

	nextItem := server.findAutomationNextQueueItem()
	if nextItem == nil || nextItem.ID != "queue_blockchain" {
		t.Fatalf("状态接口应选择当前目标岗位: %#v", nextItem)
	}

	response := httptest.NewRecorder()
	server.handleGetNextAutoQueueItem(response, httptest.NewRequest(http.MethodGet, "/api/delivery/queue/next-auto", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("获取下一自动队列项失败: code=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Item *domain.DeliveryQueueItem `json:"item"`
	}
	decodeAutomationResponse(t, response, &payload)
	if payload.Item == nil || payload.Item.ID != "queue_blockchain" {
		t.Fatalf("自动投递不应继续选择旧目标岗位: %#v", payload.Item)
	}
}

func TestHandleGetAutomationStatusMarksStaleBridgeDisconnected(t *testing.T) {
	server, store := newAutomationTestServer(t)
	saveErr := store.SaveAutomationStatus(domain.AutomationStatus{
		BridgeConnected: true,
		Phase:           "idle",
		LastSeenAt:      time.Now().Add(-2 * time.Minute),
		Errors:          []string{},
	})
	if saveErr != nil {
		t.Fatalf("保存自动化状态失败: %v", saveErr)
	}

	response := httptest.NewRecorder()
	server.handleGetAutomationStatus(response, httptest.NewRequest(http.MethodGet, "/api/automation/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("获取自动化状态失败: code=%d body=%s", response.Code, response.Body.String())
	}

	var payload struct {
		Status domain.AutomationStatus `json:"status"`
	}
	decodeAutomationResponse(t, response, &payload)
	if payload.Status.BridgeConnected {
		t.Fatalf("过期心跳不应继续显示已连接: %#v", payload.Status)
	}
}

func TestNormalizeAutomationControlDefaultsToEnabled(t *testing.T) {
	automationControl := normalizeAutomationControl(domain.AutomationControl{})
	if !automationControl.Enabled {
		t.Fatalf("未保存过控制配置时应默认开启自动模式: %#v", automationControl)
	}
	if automationControl.Keyword != defaultTargetRole {
		t.Fatalf("默认自动模式应使用默认岗位关键词: %#v", automationControl)
	}
	if automationControl.ScanIntervalMinutes != 1 {
		t.Fatalf("默认扫描间隔应为 1 分钟: %#v", automationControl)
	}
}

func TestNormalizeAutomationControlKeepsSavedTargetRole(t *testing.T) {
	automationControl := normalizeAutomationControl(domain.AutomationControl{
		Keyword:   "区块链",
		Revision:  1,
		UpdatedAt: time.Now(),
	})
	if automationControl.Keyword != "区块链" {
		t.Fatalf("已保存的目标岗位不应被默认值覆盖: %#v", automationControl)
	}
}

func TestNormalizeAutomationControlKeepsExplicitStop(t *testing.T) {
	automationControl := normalizeAutomationControl(domain.AutomationControl{
		Enabled:   false,
		Revision:  1,
		UpdatedAt: time.Now(),
	})
	if automationControl.Enabled {
		t.Fatalf("用户主动停止后不应被默认开启覆盖: %#v", automationControl)
	}
}

func newAutomationTestServer(t *testing.T) (*Server, *database.Store) {
	t.Helper()

	dataFilePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := database.Open(dataFilePath)
	if openErr != nil {
		t.Fatalf("打开测试数据存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭测试数据存储失败: %v", closeErr)
		}
	})

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := NewServer(ServerConfig{
		Store:          store,
		StaticDir:      "web",
		MaxRequestSize: 1 << 20,
		Logger:         logger,
	})
	return server, store
}

func performAutomationJSONRequest(t *testing.T, handler http.HandlerFunc, method string, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()

	body, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		t.Fatalf("编码请求失败: %v", marshalErr)
	}

	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func decodeAutomationResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if decodeErr := json.Unmarshal(response.Body.Bytes(), target); decodeErr != nil {
		t.Fatalf("解析响应失败: %v body=%s", decodeErr, response.Body.String())
	}
}

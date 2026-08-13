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

// 功能目的：校验自动聊天完成后会落库为已投递；实现原因：无障碍自动回复必须形成可追踪的最终投递状态。
func TestHandleUpdateAutoChatStatusMarksCompletedQueueItemDelivered(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	queueItemID := "queue_completed"
	seedAutoChatQueueItem(t, store, queueItemID)

	response := performAutoChatStatusRequest(t, server, queueItemID, "completed")
	if response.Code != http.StatusOK {
		t.Fatalf("自动聊天完成状态返回异常: code=%d body=%s", response.Code, response.Body.String())
	}

	queueItem, exists := store.GetQueueItem(queueItemID)
	if !exists {
		t.Fatalf("队列项不存在: %s", queueItemID)
	}
	if queueItem.Status != queueStatusDelivered {
		t.Fatalf("自动聊天完成后状态错误: got=%s want=%s", queueItem.Status, queueStatusDelivered)
	}
	if len(store.ListFeedbacks()) != 1 {
		t.Fatalf("自动聊天完成后应写入反馈记录: %#v", store.ListFeedbacks())
	}
}

// 功能目的：校验自动聊天跳过后会落库为已跳过；实现原因：猎头或异常会话不能继续占用自动投递队列。
func TestHandleUpdateAutoChatStatusMarksSkippedQueueItemSkipped(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	queueItemID := "queue_skipped"
	seedAutoChatQueueItem(t, store, queueItemID)

	response := performAutoChatStatusRequest(t, server, queueItemID, "skipped")
	if response.Code != http.StatusOK {
		t.Fatalf("自动聊天跳过状态返回异常: code=%d body=%s", response.Code, response.Body.String())
	}

	queueItem, exists := store.GetQueueItem(queueItemID)
	if !exists {
		t.Fatalf("队列项不存在: %s", queueItemID)
	}
	if queueItem.Status != queueStatusSkipped {
		t.Fatalf("自动聊天跳过后状态错误: got=%s want=%s", queueItem.Status, queueStatusSkipped)
	}
	if len(store.ListFeedbacks()) != 0 {
		t.Fatalf("跳过状态不应写入投递反馈: %#v", store.ListFeedbacks())
	}
}

// 功能目的：校验页面暂时不可用时保留队列项；实现原因：加载超时和验证页不应被误记为永久跳过。
func TestHandleUpdateAutoChatStatusKeepsStoppedQueueItemRetryable(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	queueItemID := "queue_stopped"
	seedAutoChatQueueItem(t, store, queueItemID)

	response := performAutoChatStatusRequest(t, server, queueItemID, "stopped")
	if response.Code != http.StatusOK {
		t.Fatalf("自动聊天暂停状态返回异常: code=%d body=%s", response.Code, response.Body.String())
	}

	queueItem, exists := store.GetQueueItem(queueItemID)
	if !exists {
		t.Fatalf("队列项不存在: %s", queueItemID)
	}
	if queueItem.Status != queueStatusOpened {
		t.Fatalf("暂停后队列项应保留为可重试状态: got=%s want=%s", queueItem.Status, queueStatusOpened)
	}
}

// 功能目的：校验策略排除使用拒绝状态；实现原因：猎头等明确不符合策略的岗位不应混入运行异常的跳过统计。
func TestHandleUpdateAutoChatStatusMarksRejectedQueueItemRejected(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	queueItemID := "queue_rejected"
	seedAutoChatQueueItem(t, store, queueItemID)

	response := performAutoChatStatusRequest(t, server, queueItemID, "rejected")
	if response.Code != http.StatusOK {
		t.Fatalf("自动聊天排除状态返回异常: code=%d body=%s", response.Code, response.Body.String())
	}

	queueItem, exists := store.GetQueueItem(queueItemID)
	if !exists {
		t.Fatalf("队列项不存在: %s", queueItemID)
	}
	if queueItem.Status != queueStatusRejected {
		t.Fatalf("策略排除后状态错误: got=%s want=%s", queueItem.Status, queueStatusRejected)
	}
}

// 功能目的：校验非法自动聊天状态会被拒绝；实现原因：避免前端误传状态污染队列状态机。
func TestHandleUpdateAutoChatStatusRejectsInvalidStatus(t *testing.T) {
	server, store := newAutoChatStatusTestServer(t)
	queueItemID := "queue_invalid"
	seedAutoChatQueueItem(t, store, queueItemID)

	response := performAutoChatStatusRequest(t, server, queueItemID, "active")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("非法状态应返回 400: code=%d body=%s", response.Code, response.Body.String())
	}

	queueItem, exists := store.GetQueueItem(queueItemID)
	if !exists {
		t.Fatalf("队列项不存在: %s", queueItemID)
	}
	if queueItem.Status != queueStatusOpened {
		t.Fatalf("非法状态不应修改队列项: got=%s want=%s", queueItem.Status, queueStatusOpened)
	}
}

func newAutoChatStatusTestServer(t *testing.T) (*Server, *database.Store) {
	t.Helper()

	dataFilePath := filepath.Join(t.TempDir(), "auto-chat-status.json")
	store, openError := database.Open(dataFilePath)
	if openError != nil {
		t.Fatalf("创建测试存储失败: %v", openError)
	}
	t.Cleanup(func() {
		if closeError := store.Close(); closeError != nil {
			t.Fatalf("关闭测试存储失败: %v", closeError)
		}
	})

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := NewServer(ServerConfig{
		Store:          store,
		StaticDir:      filepath.Join("..", "..", "web"),
		MaxRequestSize: 1 << 20,
		Logger:         logger,
	})
	return server, store
}

func seedAutoChatQueueItem(t *testing.T, store *database.Store, queueItemID string) {
	t.Helper()

	now := time.Now()
	queueItem := domain.DeliveryQueueItem{
		ID:        queueItemID,
		JobID:     "job_" + queueItemID,
		Title:     "Go 后端工程师",
		Company:   "可访问科技",
		Status:    queueStatusOpened,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if saveError := store.SaveQueueItems([]domain.DeliveryQueueItem{queueItem}); saveError != nil {
		t.Fatalf("写入测试队列项失败: %v", saveError)
	}
}

func performAutoChatStatusRequest(t *testing.T, server *Server, queueItemID string, status string) *httptest.ResponseRecorder {
	t.Helper()

	requestBody, marshalError := json.Marshal(map[string]string{
		"queueItemId": queueItemID,
		"status":      status,
	})
	if marshalError != nil {
		t.Fatalf("构造请求失败: %v", marshalError)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/chat/auto/status", bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	return response
}

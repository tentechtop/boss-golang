package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAutoChatReplyRequiresExistingResume(t *testing.T) {
	server, _ := newAutoChatStatusTestServer(t)

	for _, testCase := range []struct {
		name     string
		resumeID string
		expected string
	}{
		{name: "missing resume", resumeID: "", expected: "必须选择有效简历"},
		{name: "unknown resume", resumeID: "resume_missing", expected: "简历不存在"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			payload := autoChatReplyRequest{
				JobID:        "boss_chat_job_test",
				JobTitle:     "Golang 后端工程师",
				JobCompany:   "测试公司",
				ResumeID:     testCase.resumeID,
				HrNewMessage: "方便聊聊吗？",
			}
			requestBody, marshalError := json.Marshal(payload)
			if marshalError != nil {
				t.Fatal(marshalError)
			}

			request := httptest.NewRequest(http.MethodPost, "/api/chat/auto/reply", bytes.NewReader(requestBody))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("缺少有效简历时状态码错误: got=%d body=%s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), testCase.expected) {
				t.Fatalf("缺少有效简历时错误信息不明确: %s", response.Body.String())
			}
		})
	}
}

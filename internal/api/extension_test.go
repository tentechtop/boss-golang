package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandleDownloadExtensionPackage(t *testing.T) {
	tempDir := t.TempDir()
	extensionDir := filepath.Join(tempDir, "extension")
	if mkdirErr := os.MkdirAll(extensionDir, 0755); mkdirErr != nil {
		t.Fatalf("创建测试扩展目录失败: %v", mkdirErr)
	}

	if writeErr := os.WriteFile(filepath.Join(extensionDir, "manifest.json"), []byte(`{"name":"test"}`), 0644); writeErr != nil {
		t.Fatalf("写入测试文件失败: %v", writeErr)
	}
	if writeErr := os.WriteFile(filepath.Join(extensionDir, "popup.html"), []byte("<html></html>"), 0644); writeErr != nil {
		t.Fatalf("写入测试文件失败: %v", writeErr)
	}

	server, _ := newAutomationTestServer(t)
	t.Setenv("BOSS_EXTENSION_DIR", extensionDir)

	request := httptest.NewRequest(http.MethodGet, "/api/extension/package", nil)
	response := httptest.NewRecorder()
	server.handleDownloadExtensionPackage(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("下载扩展安装包失败: code=%d body=%s", response.Code, response.Body.String())
	}

	zipReader, openErr := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if openErr != nil {
		t.Fatalf("响应内容不是合法 zip: %v", openErr)
	}

	foundManifest := false
	foundPopup := false
	for _, file := range zipReader.File {
		if file.Name == "manifest.json" {
			foundManifest = true
		}
		if file.Name == "popup.html" {
			foundPopup = true
		}
	}
	if !foundManifest || !foundPopup {
		t.Fatalf("压缩包内容缺失关键文件: manifest=%v popup=%v", foundManifest, foundPopup)
	}
}

func TestResolveExtensionDirWithCandidates(t *testing.T) {
	candidatesDir := t.TempDir()
	customDir := filepath.Join(candidatesDir, "custom-static")
	extensionCandidate := filepath.Join(customDir, "extension")
	if mkdirErr := os.MkdirAll(extensionCandidate, 0755); mkdirErr != nil {
		t.Fatalf("创建候选目录失败: %v", mkdirErr)
	}

	realDir, resolveErr := resolveExtensionDirWithCandidates(customDir)
	if resolveErr != nil {
		t.Fatalf("解析 extension 目录失败: %v", resolveErr)
	}
	if realDir != filepath.Clean(extensionCandidate) {
		t.Fatalf("解析结果不符合预期: got=%s", realDir)
	}
}

func TestHandleLaunchExtensionBrowser(t *testing.T) {
	server, _ := newAutomationTestServer(t)
	launchCount := 0
	server.browserLaunchFunc = func() error {
		launchCount++
		return nil
	}

	request := httptest.NewRequest(http.MethodPost, "/api/extension/launch", nil)
	response := httptest.NewRecorder()
	server.handleLaunchExtensionBrowser(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("一键启动扩展浏览器失败: code=%d body=%s", response.Code, response.Body.String())
	}

	var payload struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if decodeErr := json.Unmarshal(response.Body.Bytes(), &payload); decodeErr != nil {
		t.Fatalf("解析响应失败: %v body=%s", decodeErr, response.Body.String())
	}
	if !payload.OK {
		t.Fatalf("响应应返回 ok=true: %#v", payload)
	}
	if payload.Message == "" {
		t.Fatalf("响应 message 不能为空: %#v", payload)
	}
	if launchCount != 1 {
		t.Fatalf("启动函数未被正确调用: got=%d want=1", launchCount)
	}
}

func TestHandleLaunchExtensionBrowserRejectsInvalidMethod(t *testing.T) {
	server, _ := newAutomationTestServer(t)
	request := httptest.NewRequest(http.MethodGet, "/api/extension/launch", nil)
	response := httptest.NewRecorder()
	server.handleLaunchExtensionBrowser(response, request)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("应拒绝非 POST 方法: got=%d", response.Code)
	}
}

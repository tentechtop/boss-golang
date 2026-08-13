package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"boss-job-assistant/internal/database"
)

// 导入接口测试：校验粘贴简历能生成并落库存储；实现原因：一键自动求职入口必须先有稳定的简历导入闭环。
func TestHandleImportResumeCreatesResume(t *testing.T) {
	server, store := newResumeImportTestServer(t)

	requestBody, marshalError := json.Marshal(map[string]any{
		"resumeText": "姓名：李四\n求职意向：Go 后端工程师\n所在城市：杭州\n邮箱：test@example.com\n技能：Go、Redis",
		"profile": map[string]any{
			"targetRole": "Go 后端工程师",
			"location":   "杭州",
		},
	})
	if marshalError != nil {
		t.Fatalf("构造导入请求失败: %v", marshalError)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/resumes/import", bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("导入简历接口返回异常: code=%d body=%s", response.Code, response.Body.String())
	}
	if len(store.ListResumes()) != 1 {
		t.Fatalf("导入简历后落库数量错误: %#v", store.ListResumes())
	}
}

// 导入接口测试：校验空简历内容会被拒绝；实现原因：空输入进入自动链路会导致后续搜索和聊天全部失真。
func TestHandleImportResumeRejectsEmptyResume(t *testing.T) {
	server, _ := newResumeImportTestServer(t)

	requestBody, marshalError := json.Marshal(map[string]any{
		"resumeText": "   ",
		"profile": map[string]any{
			"targetRole": "Go 后端工程师",
		},
	})
	if marshalError != nil {
		t.Fatalf("构造导入请求失败: %v", marshalError)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/resumes/import", bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("空简历内容应返回 400: code=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHandleImportResumeFileCreatesResume(t *testing.T) {
	server, store := newResumeImportTestServer(t)
	requestBody, contentType := buildResumeFileRequest(t, "resume.txt", []byte("姓名：王五\n求职意向：Go 后端工程师\n技能：Go、MySQL"))

	request := httptest.NewRequest(http.MethodPost, "/api/resumes/import-file", requestBody)
	request.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("上传简历接口返回异常: code=%d body=%s", response.Code, response.Body.String())
	}
	if len(store.ListResumes()) != 1 {
		t.Fatalf("上传简历后落库数量错误: %#v", store.ListResumes())
	}
	if storedResume := store.ListResumes()[0]; storedResume.SourceFileName != "resume.txt" {
		t.Fatalf("上传简历后未保存原文件名: %#v", storedResume)
	}
}

func TestHandleImportResumeFileAcceptsFileLargerThanOneMB(t *testing.T) {
	server, store := newResumeImportTestServer(t)
	largeResumeContent := bytes.Repeat([]byte("a"), (1<<20)+1)
	requestBody, contentType := buildResumeFileRequest(t, "resume.txt", largeResumeContent)

	request := httptest.NewRequest(http.MethodPost, "/api/resumes/import-file", requestBody)
	request.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("超过 1MB 的简历文件应允许上传: code=%d body=%s", response.Code, response.Body.String())
	}
	if len(store.ListResumes()) != 1 {
		t.Fatalf("上传超过 1MB 的简历后落库数量错误: %#v", store.ListResumes())
	}
}

func TestExtractResumeTextFromDOCX(t *testing.T) {
	var docxContent bytes.Buffer
	zipWriter := zip.NewWriter(&docxContent)
	documentWriter, createError := zipWriter.Create("word/document.xml")
	if createError != nil {
		t.Fatalf("创建 DOCX 正文失败: %v", createError)
	}
	_, writeError := io.WriteString(documentWriter, `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Go 后端工程师</w:t></w:r></w:p><w:p><w:r><w:t>熟悉 MySQL</w:t></w:r></w:p></w:body></w:document>`)
	if writeError != nil {
		t.Fatalf("写入 DOCX 正文失败: %v", writeError)
	}
	if closeError := zipWriter.Close(); closeError != nil {
		t.Fatalf("关闭 DOCX 测试文件失败: %v", closeError)
	}

	resumeText, extractError := extractResumeText("resume.docx", docxContent.Bytes())
	if extractError != nil {
		t.Fatalf("提取 DOCX 简历失败: %v", extractError)
	}
	if resumeText != "Go 后端工程师\n熟悉 MySQL" {
		t.Fatalf("DOCX 文本不符合预期: %q", resumeText)
	}
}

func TestExtractResumeTextRejectsInvalidFiles(t *testing.T) {
	testCases := []struct {
		name     string
		fileName string
		content  []byte
	}{
		{name: "empty", fileName: "resume.txt", content: nil},
		{name: "unsupported", fileName: "resume.pdf", content: []byte("pdf")},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, extractError := extractResumeText(testCase.fileName, testCase.content); extractError == nil {
				t.Fatalf("无效文件应返回错误: %s", testCase.fileName)
			}
		})
	}
}

func buildResumeFileRequest(t *testing.T, fileName string, content []byte) (*bytes.Buffer, string) {
	t.Helper()

	var requestBody bytes.Buffer
	multipartWriter := multipart.NewWriter(&requestBody)
	fileWriter, createError := multipartWriter.CreateFormFile("resumeFile", fileName)
	if createError != nil {
		t.Fatalf("创建上传文件字段失败: %v", createError)
	}
	if _, writeError := fileWriter.Write(content); writeError != nil {
		t.Fatalf("写入上传文件失败: %v", writeError)
	}
	if writeError := multipartWriter.WriteField("targetRole", "golang后端"); writeError != nil {
		t.Fatalf("写入目标岗位失败: %v", writeError)
	}
	if writeError := multipartWriter.WriteField("location", "深圳市"); writeError != nil {
		t.Fatalf("写入目标城市失败: %v", writeError)
	}
	if closeError := multipartWriter.Close(); closeError != nil {
		t.Fatalf("关闭 multipart 请求失败: %v", closeError)
	}
	return &requestBody, multipartWriter.FormDataContentType()
}

func newResumeImportTestServer(t *testing.T) (*Server, *database.Store) {
	t.Helper()

	dataFilePath := filepath.Join(t.TempDir(), "resume-import.json")
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

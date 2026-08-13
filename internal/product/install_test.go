package product

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestExtractZIPWritesPayload(t *testing.T) {
	payload := buildTestZIP(t, map[string]string{
		"web/index.html":          "<h1>Boss Job Copilot</h1>",
		"extension/manifest.json": `{"manifest_version":3}`,
	})
	destination := t.TempDir()

	if extractErr := ExtractZIP(payload, destination); extractErr != nil {
		t.Fatalf("解压有效产品包失败: %v", extractErr)
	}
	content, readErr := os.ReadFile(filepath.Join(destination, "web", "index.html"))
	if readErr != nil {
		t.Fatalf("读取解压文件失败: %v", readErr)
	}
	if string(content) != "<h1>Boss Job Copilot</h1>" {
		t.Fatalf("解压文件内容错误: %s", content)
	}
}

func TestExtractZIPRejectsPathTraversal(t *testing.T) {
	for _, archiveName := range []string{"../outside.txt", `..\outside.txt`} {
		t.Run(archiveName, func(t *testing.T) {
			payload := buildTestZIP(t, map[string]string{archiveName: "blocked"})
			destination := filepath.Join(t.TempDir(), "app")
			if extractErr := ExtractZIP(payload, destination); extractErr == nil {
				t.Fatalf("路径穿越文件不应解压: %s", archiveName)
			}
		})
	}
}

func TestPayloadMarkerAllowsRepeatedClickWithoutReinstall(t *testing.T) {
	payload := buildTestZIP(t, map[string]string{
		"BossJobService.exe":      "service-binary",
		"web/index.html":          "<h1>Boss Job Copilot</h1>",
		"extension/manifest.json": `{"manifest_version":3}`,
		"extension/background.js": "service worker",
	})
	destination := t.TempDir()

	if IsPayloadInstalled(payload, destination) {
		t.Fatal("尚未释放的安装包不应被判定为已安装")
	}
	if extractErr := ExtractZIP(payload, destination); extractErr != nil {
		t.Fatalf("释放测试安装包失败: %v", extractErr)
	}
	if IsPayloadInstalled(payload, destination) {
		t.Fatal("未写入内容摘要时不应跳过安装")
	}
	if markerErr := MarkPayloadInstalled(payload, destination); markerErr != nil {
		t.Fatalf("写入产品内容摘要失败: %v", markerErr)
	}
	if !IsPayloadInstalled(payload, destination) {
		t.Fatal("内容摘要和必要文件完整时应直接复用现有安装")
	}

	changedPayload := append(append([]byte(nil), payload...), byte(0))
	if IsPayloadInstalled(changedPayload, destination) {
		t.Fatal("安装包内容变化后必须执行升级")
	}
	if removeErr := os.Remove(filepath.Join(destination, "extension", "manifest.json")); removeErr != nil {
		t.Fatalf("删除测试必要文件失败: %v", removeErr)
	}
	if IsPayloadInstalled(payload, destination) {
		t.Fatal("必要文件缺失时必须重新安装")
	}
}

func buildTestZIP(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var payload bytes.Buffer
	archiveWriter := zip.NewWriter(&payload)
	for fileName, content := range files {
		fileWriter, createErr := archiveWriter.Create(fileName)
		if createErr != nil {
			t.Fatalf("创建测试压缩文件失败: %v", createErr)
		}
		if _, writeErr := fileWriter.Write([]byte(content)); writeErr != nil {
			t.Fatalf("写入测试压缩文件失败: %v", writeErr)
		}
	}
	if closeErr := archiveWriter.Close(); closeErr != nil {
		t.Fatalf("关闭测试压缩包失败: %v", closeErr)
	}
	return payload.Bytes()
}

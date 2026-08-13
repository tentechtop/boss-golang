package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScanProjectDetectsGoStack(t *testing.T) {
	tempDirectory := t.TempDir()
	writeTestFile(t, filepath.Join(tempDirectory, "go.mod"), "module demo\n")
	writeTestFile(t, filepath.Join(tempDirectory, "README.md"), "这是一个 Go 微服务项目，使用 Redis 和 MySQL。\n")
	if mkdirErr := os.Mkdir(filepath.Join(tempDirectory, "internal"), 0755); mkdirErr != nil {
		t.Fatalf("创建测试目录失败: %v", mkdirErr)
	}

	summary, scanErr := ScanProject(tempDirectory)
	if scanErr != nil {
		t.Fatalf("扫描项目失败: %v", scanErr)
	}

	if summary.Name == "" {
		t.Fatalf("项目名称不能为空")
	}
	if len(summary.TechStack) == 0 {
		t.Fatalf("技术栈不能为空")
	}
	if summary.FileCount == 0 {
		t.Fatalf("文件数量必须大于 0")
	}
}

func writeTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if writeErr := os.WriteFile(path, []byte(content), 0644); writeErr != nil {
		t.Fatalf("写入测试文件失败: %v", writeErr)
	}
}

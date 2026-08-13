package api

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const extensionPackageFileName = "job-copilot-extension.zip"

// handleDownloadExtensionPackage 为前端提供可直接下载的扩展安装包。
// 说明：
// - 只从本地 extension 目录读取，不接收外部路径参数，避免目录遍历攻击；
// - 统一返回错误上下文，便于日志追踪和前端提示；
// - 先打包到内存再返回，避免响应半写入造成异常。
func (server *Server) handleDownloadExtensionPackage(responseWriter http.ResponseWriter, _ *http.Request) {
	extensionDir, resolveErr := server.resolveExtensionDir()
	if resolveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, resolveErr)
		return
	}

	payload, zipErr := buildExtensionZip(extensionDir)
	if zipErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, zipErr)
		return
	}

	responseWriter.Header().Set("Content-Type", "application/zip")
	responseWriter.Header().Set("Content-Disposition", "attachment; filename=\""+extensionPackageFileName+"\"")
	responseWriter.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))
	responseWriter.Header().Set("Cache-Control", "no-store")
	responseWriter.WriteHeader(http.StatusOK)
	if _, writeErr := responseWriter.Write(payload); writeErr != nil && server.logger != nil {
		server.logger.Error("写入扩展安装包响应失败", "error", writeErr)
	}
}

// handleLaunchExtensionBrowser 在本地启动专用 Edge 并预加载插件，满足“点击即接管”的一键操作。
func (server *Server) handleLaunchExtensionBrowser(responseWriter http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(responseWriter, http.StatusMethodNotAllowed, fmt.Errorf("只允许 POST 请求"))
		return
	}

	if launchErr := server.launchDedicatedBrowser(); launchErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, launchErr)
		return
	}

	if server.logger != nil {
		server.logger.Info("手动触发专用浏览器启动")
	}

	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "一键安装命令已提交：专用 Edge 正在启动，请稍后确认扩展桥接状态。",
	})
}

func buildExtensionZip(extensionDir string) ([]byte, error) {
	var buffer bytes.Buffer
	zipWriter := zip.NewWriter(&buffer)
	if zipErr := addDirToZip(zipWriter, extensionDir, extensionDir); zipErr != nil {
		_ = zipWriter.Close()
		return nil, fmt.Errorf("构建扩展安装包失败: %w", zipErr)
	}
	if closeErr := zipWriter.Close(); closeErr != nil {
		return nil, fmt.Errorf("关闭压缩包写入器失败: %w", closeErr)
	}
	return buffer.Bytes(), nil
}

func addDirToZip(zipWriter *zip.Writer, rootDir string, currentDir string) error {
	entries, readDirErr := os.ReadDir(currentDir)
	if readDirErr != nil {
		return fmt.Errorf("读取目录失败: %w", readDirErr)
	}

	for _, entry := range entries {
		entryName := strings.TrimSpace(entry.Name())
		if entryName == "" || shouldSkipExtensionEntry(entryName) {
			continue
		}

		entryPath := filepath.Join(currentDir, entryName)
		relativePath, relErr := filepath.Rel(rootDir, entryPath)
		if relErr != nil || strings.HasPrefix(relativePath, "..") {
			return fmt.Errorf("计算相对路径失败: %s", entryName)
		}
		zipPath := filepath.ToSlash(relativePath)

		if entry.IsDir() {
			if nestedErr := addDirToZip(zipWriter, rootDir, entryPath); nestedErr != nil {
				return nestedErr
			}
			continue
		}

		fileHandle, openErr := os.Open(entryPath)
		if openErr != nil {
			return fmt.Errorf("打开文件失败: %s, %w", zipPath, openErr)
		}

		fileInfo, infoErr := fileHandle.Stat()
		if infoErr != nil {
			_ = fileHandle.Close()
			return fmt.Errorf("读取文件信息失败: %s, %w", zipPath, infoErr)
		}

		header, headerErr := zip.FileInfoHeader(fileInfo)
		if headerErr != nil {
			_ = fileHandle.Close()
			return fmt.Errorf("创建 zip 条目失败: %s, %w", zipPath, headerErr)
		}
		header.Name = zipPath
		header.Method = zip.Deflate

		fileWriter, createErr := zipWriter.CreateHeader(header)
		if createErr != nil {
			_ = fileHandle.Close()
			return fmt.Errorf("写入 zip 条目失败: %s, %w", zipPath, createErr)
		}

		if _, copyErr := io.Copy(fileWriter, fileHandle); copyErr != nil {
			_ = fileHandle.Close()
			return fmt.Errorf("复制文件内容失败: %s, %w", zipPath, copyErr)
		}
		if closeErr := fileHandle.Close(); closeErr != nil {
			return fmt.Errorf("关闭源文件失败: %s, %w", zipPath, closeErr)
		}
	}

	return nil
}

func shouldSkipExtensionEntry(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}

func (server *Server) resolveExtensionDir() (string, error) {
	return resolveExtensionDirWithCandidates(server.staticDir)
}

func resolveExtensionDirWithCandidates(staticDir string) (string, error) {
	candidates := []string{}

	if envValue := strings.TrimSpace(os.Getenv("BOSS_EXTENSION_DIR")); envValue != "" {
		candidates = append(candidates, envValue)
	}
	candidates = append(candidates,
		filepath.Join(staticDir, "..", "extension"),
		filepath.Join(staticDir, "extension"),
		filepath.Join("extension"),
	)

	if currentDir, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(currentDir, "extension"),
			filepath.Join(currentDir, "..", "extension"),
		)
	}

	if executablePath, err := os.Executable(); err == nil {
		execDir := filepath.Dir(executablePath)
		candidates = append(candidates,
			filepath.Join(execDir, "extension"),
			filepath.Join(execDir, "..", "extension"),
		)
	}

	for _, candidate := range candidates {
		normalized, normalizeErr := filepath.Abs(filepath.Clean(candidate))
		if normalizeErr != nil || strings.TrimSpace(normalized) == "" {
			continue
		}
		info, statErr := os.Stat(normalized)
		if statErr == nil && info.IsDir() {
			return normalized, nil
		}
	}

	return "", fmt.Errorf("无法定位 extension 目录")
}

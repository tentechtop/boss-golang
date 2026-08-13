package product

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxExtractedBytes int64 = 512 * 1024 * 1024

const payloadMarkerFileName = ".payload.sha256"

var requiredPayloadFiles = []string{
	"BossJobService.exe",
	filepath.Join("web", "index.html"),
	filepath.Join("extension", "manifest.json"),
}

// IsPayloadInstalled 判断同一安装包是否已经完整释放，重复双击时可直接启动而不覆盖运行中的服务。
func IsPayloadInstalled(payload []byte, destination string) bool {
	if len(payload) == 0 || strings.TrimSpace(destination) == "" {
		return false
	}
	markerContent, readErr := os.ReadFile(filepath.Join(destination, payloadMarkerFileName))
	if readErr != nil || strings.TrimSpace(string(markerContent)) != payloadChecksum(payload) {
		return false
	}
	for _, relativePath := range requiredPayloadFiles {
		fileInfo, statErr := os.Stat(filepath.Join(destination, relativePath))
		if statErr != nil || fileInfo.IsDir() {
			return false
		}
	}
	return true
}

// MarkPayloadInstalled 在全部文件释放成功后记录包内容摘要，后续启动据此区分“直接运行”和“需要升级”。
func MarkPayloadInstalled(payload []byte, destination string) error {
	if len(payload) == 0 {
		return fmt.Errorf("产品安装包为空")
	}
	if strings.TrimSpace(destination) == "" {
		return fmt.Errorf("产品安装目录不能为空")
	}
	if makeErr := os.MkdirAll(destination, 0o755); makeErr != nil {
		return fmt.Errorf("创建产品安装目录失败: %w", makeErr)
	}
	markerPath := filepath.Join(destination, payloadMarkerFileName)
	if writeErr := os.WriteFile(markerPath, []byte(payloadChecksum(payload)+"\n"), 0o644); writeErr != nil {
		return fmt.Errorf("写入产品内容摘要失败: %w", writeErr)
	}
	return nil
}

func payloadChecksum(payload []byte) string {
	checksum := sha256.Sum256(payload)
	return fmt.Sprintf("%x", checksum[:])
}

// ExtractZIP installs the trusted embedded payload while still enforcing archive boundaries.
func ExtractZIP(payload []byte, destination string) error {
	if len(payload) == 0 {
		return fmt.Errorf("产品安装包为空")
	}
	if strings.TrimSpace(destination) == "" {
		return fmt.Errorf("产品安装目录不能为空")
	}

	archiveReader, archiveErr := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if archiveErr != nil {
		return fmt.Errorf("读取产品安装包失败: %w", archiveErr)
	}
	if makeErr := os.MkdirAll(destination, 0o755); makeErr != nil {
		return fmt.Errorf("创建产品安装目录失败: %w", makeErr)
	}

	var extractedBytes int64
	for _, archiveFile := range archiveReader.File {
		if archiveFile.FileInfo().Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("产品安装包包含不允许的符号链接: %s", archiveFile.Name)
		}
		fileSize := int64(archiveFile.UncompressedSize64)
		if fileSize < 0 || fileSize > maxExtractedBytes-extractedBytes {
			return fmt.Errorf("产品安装包解压后超过 %d MB", maxExtractedBytes/(1024*1024))
		}
		extractedBytes += fileSize

		targetPath, targetErr := safeArchiveTarget(destination, archiveFile.Name)
		if targetErr != nil {
			return targetErr
		}
		if archiveFile.FileInfo().IsDir() {
			if makeErr := os.MkdirAll(targetPath, 0o755); makeErr != nil {
				return fmt.Errorf("创建安装子目录 %s 失败: %w", archiveFile.Name, makeErr)
			}
			continue
		}

		if makeErr := os.MkdirAll(filepath.Dir(targetPath), 0o755); makeErr != nil {
			return fmt.Errorf("创建文件目录 %s 失败: %w", archiveFile.Name, makeErr)
		}
		sourceFile, openErr := archiveFile.Open()
		if openErr != nil {
			return fmt.Errorf("打开安装文件 %s 失败: %w", archiveFile.Name, openErr)
		}
		targetFile, createErr := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if createErr != nil {
			sourceFile.Close()
			return fmt.Errorf("创建安装文件 %s 失败: %w", archiveFile.Name, createErr)
		}

		_, copyErr := io.Copy(targetFile, sourceFile)
		targetCloseErr := targetFile.Close()
		sourceCloseErr := sourceFile.Close()
		if copyErr != nil {
			_ = os.Remove(targetPath)
			return fmt.Errorf("写入安装文件 %s 失败: %w", archiveFile.Name, copyErr)
		}
		if targetCloseErr != nil {
			return fmt.Errorf("关闭安装文件 %s 失败: %w", archiveFile.Name, targetCloseErr)
		}
		if sourceCloseErr != nil {
			return fmt.Errorf("关闭安装包文件 %s 失败: %w", archiveFile.Name, sourceCloseErr)
		}
	}
	return nil
}

func safeArchiveTarget(destination string, archiveName string) (string, error) {
	cleanedName := filepath.Clean(filepath.FromSlash(archiveName))
	if cleanedName == "." || filepath.IsAbs(cleanedName) || filepath.VolumeName(cleanedName) != "" {
		return "", fmt.Errorf("产品安装包包含非法路径: %s", archiveName)
	}

	destinationPath, destinationErr := filepath.Abs(destination)
	if destinationErr != nil {
		return "", fmt.Errorf("解析产品安装目录失败: %w", destinationErr)
	}
	targetPath, targetErr := filepath.Abs(filepath.Join(destinationPath, cleanedName))
	if targetErr != nil {
		return "", fmt.Errorf("解析安装文件路径失败: %w", targetErr)
	}
	relativePath, relativeErr := filepath.Rel(destinationPath, targetPath)
	if relativeErr != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("产品安装包路径越界: %s", archiveName)
	}
	return targetPath, nil
}

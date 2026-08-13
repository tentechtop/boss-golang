package security

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var blockedDirectoryNames = map[string]struct{}{
	"windows":             {},
	"program files":       {},
	"program files (x86)": {},
	"system32":            {},
}

func ValidateProjectPath(rawPath string) (string, error) {
	cleanedPath := strings.TrimSpace(rawPath)
	if cleanedPath == "" {
		return "", fmt.Errorf("项目路径不能为空")
	}

	absolutePath, absoluteErr := filepath.Abs(cleanedPath)
	if absoluteErr != nil {
		return "", fmt.Errorf("解析项目绝对路径失败: %w", absoluteErr)
	}

	info, statErr := os.Stat(absolutePath)
	if statErr != nil {
		return "", fmt.Errorf("项目路径不可访问: %w", statErr)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("项目路径必须是目录")
	}

	if isDriveRoot(absolutePath) {
		return "", fmt.Errorf("禁止扫描磁盘根目录")
	}

	if containsBlockedDirectory(absolutePath) {
		return "", fmt.Errorf("禁止扫描系统目录")
	}

	return absolutePath, nil
}

func isDriveRoot(path string) bool {
	volumeName := filepath.VolumeName(path)
	if volumeName == "" {
		return filepath.Clean(path) == string(filepath.Separator)
	}

	withoutVolume := strings.TrimPrefix(filepath.Clean(path), volumeName)
	return withoutVolume == string(filepath.Separator) || withoutVolume == ""
}

func containsBlockedDirectory(path string) bool {
	volumeName := filepath.VolumeName(path)
	pathWithoutVolume := strings.TrimPrefix(filepath.Clean(path), volumeName)
	parts := strings.Split(pathWithoutVolume, string(filepath.Separator))
	for _, part := range parts {
		if _, blocked := blockedDirectoryNames[strings.ToLower(part)]; blocked {
			return true
		}
	}
	return false
}

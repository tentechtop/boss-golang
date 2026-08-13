//go:build windows

package product

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const serviceExecutableName = "BossJobService.exe"

// StopRunningServices stops only BossJobService processes whose executable is inside productRoot.
// This releases the executable before an in-place upgrade without affecting similarly named programs elsewhere.
func StopRunningServices(productRoot string, waitTimeout time.Duration) error {
	cleanRoot, rootErr := filepath.Abs(strings.TrimSpace(productRoot))
	if rootErr != nil || strings.TrimSpace(productRoot) == "" {
		return fmt.Errorf("产品安装根目录无效")
	}

	snapshot, snapshotErr := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if snapshotErr != nil {
		return fmt.Errorf("枚举本地服务进程失败: %w", snapshotErr)
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if firstErr := windows.Process32First(snapshot, &entry); firstErr != nil {
		return fmt.Errorf("读取本地服务进程失败: %w", firstErr)
	}

	for {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), serviceExecutableName) {
			if stopErr := stopServiceProcessInRoot(entry.ProcessID, cleanRoot, waitTimeout); stopErr != nil {
				return stopErr
			}
		}

		nextErr := windows.Process32Next(snapshot, &entry)
		if nextErr == nil {
			continue
		}
		if nextErr == windows.ERROR_NO_MORE_FILES {
			break
		}
		return fmt.Errorf("继续读取本地服务进程失败: %w", nextErr)
	}

	return nil
}

func stopServiceProcessInRoot(processID uint32, productRoot string, waitTimeout time.Duration) error {
	access := uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.PROCESS_TERMINATE | windows.SYNCHRONIZE)
	processHandle, openErr := windows.OpenProcess(access, false, processID)
	if openErr != nil {
		// 进程可能在枚举后已经退出，此时无需阻止安装继续。
		return nil
	}
	defer windows.CloseHandle(processHandle)

	executablePath, pathErr := queryProcessExecutablePath(processHandle)
	if pathErr != nil || !isPathWithinDirectory(executablePath, productRoot) {
		return nil
	}
	if terminateErr := windows.TerminateProcess(processHandle, 0); terminateErr != nil {
		return fmt.Errorf("停止旧版服务进程 %d 失败: %w", processID, terminateErr)
	}

	waitMilliseconds := waitTimeout.Milliseconds()
	if waitMilliseconds <= 0 {
		waitMilliseconds = 10_000
	}
	if waitMilliseconds >= int64(windows.INFINITE) {
		waitMilliseconds = int64(windows.INFINITE - 1)
	}
	waitResult, waitErr := windows.WaitForSingleObject(processHandle, uint32(waitMilliseconds))
	if waitErr != nil {
		return fmt.Errorf("等待旧版服务进程 %d 退出失败: %w", processID, waitErr)
	}
	if waitResult != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("旧版服务进程 %d 未在 %s 内退出", processID, waitTimeout)
	}
	return nil
}

func queryProcessExecutablePath(processHandle windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	bufferSize := uint32(len(buffer))
	if queryErr := windows.QueryFullProcessImageName(processHandle, 0, &buffer[0], &bufferSize); queryErr != nil {
		return "", queryErr
	}
	return filepath.Clean(windows.UTF16ToString(buffer[:bufferSize])), nil
}

func isPathWithinDirectory(candidatePath string, directoryPath string) bool {
	candidate, candidateErr := filepath.Abs(strings.TrimSpace(candidatePath))
	directory, directoryErr := filepath.Abs(strings.TrimSpace(directoryPath))
	if candidateErr != nil || directoryErr != nil || candidatePath == "" || directoryPath == "" {
		return false
	}
	directoryPrefix := strings.ToLower(strings.TrimRight(filepath.Clean(directory), string(os.PathSeparator)) + string(os.PathSeparator))
	return strings.HasPrefix(strings.ToLower(filepath.Clean(candidate)), directoryPrefix)
}

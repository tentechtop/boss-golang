//go:build windows && product_installer

package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"boss-job-assistant/internal/product"
)

//go:embed payload.zip
var embeddedPayload []byte

var productVersion = "development"

const (
	serverURL      = "http://127.0.0.1:8083"
	edgeDebugURL   = "http://127.0.0.1:9223/json/list"
	createNoWindow = 0x08000000
)

func main() {
	if runErr := run(); runErr != nil {
		log.Printf("产品启动失败: %v", runErr)
		showMessage("自动求职启动失败", runErr.Error(), 0x10)
		os.Exit(1)
	}
}

func run() error {
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if localAppData == "" {
		return fmt.Errorf("系统没有提供 LOCALAPPDATA，无法确定安装目录")
	}
	if strings.TrimSpace(productVersion) == "" || strings.ContainsAny(productVersion, `\/:*?"<>|`) {
		return fmt.Errorf("产品版本号非法: %s", productVersion)
	}

	productRoot := filepath.Join(localAppData, "BossJobCopilot")
	installDirectory := filepath.Join(productRoot, "app-"+productVersion)
	logDirectory := filepath.Join(productRoot, "logs")
	if makeErr := os.MkdirAll(logDirectory, 0o755); makeErr != nil {
		return fmt.Errorf("创建日志目录失败: %w", makeErr)
	}
	launcherLog, logErr := os.OpenFile(filepath.Join(logDirectory, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if logErr != nil {
		return fmt.Errorf("创建启动日志失败: %w", logErr)
	}
	defer launcherLog.Close()
	log.SetOutput(launcherLog)
	log.Printf("开始安装并启动 Boss Job Copilot %s", productVersion)

	if product.IsPayloadInstalled(embeddedPayload, installDirectory) {
		log.Printf("产品文件未变化，直接复用现有安装目录")
	} else {
		// 升级同一版本时，旧服务仍会占用 BossJobService.exe；必须先停止本产品目录内的服务再覆盖文件。
		if stopErr := product.StopRunningServices(productRoot, 10*time.Second); stopErr != nil {
			return fmt.Errorf("停止旧版本地服务失败: %w", stopErr)
		}
		if extractErr := product.ExtractZIP(embeddedPayload, installDirectory); extractErr != nil {
			return fmt.Errorf("安装产品文件失败: %w", extractErr)
		}
		if markerErr := product.MarkPayloadInstalled(embeddedPayload, installDirectory); markerErr != nil {
			return fmt.Errorf("记录产品版本失败: %w", markerErr)
		}
	}

	dataDirectory := filepath.Join(productRoot, "data")
	edgeProfileDirectory := filepath.Join(productRoot, "EdgeProfile")
	if makeErr := os.MkdirAll(dataDirectory, 0o755); makeErr != nil {
		return fmt.Errorf("创建数据目录失败: %w", makeErr)
	}
	if makeErr := os.MkdirAll(edgeProfileDirectory, 0o755); makeErr != nil {
		return fmt.Errorf("创建 Edge 登录目录失败: %w", makeErr)
	}

	if !serverHealthy() {
		if startErr := startService(productRoot, installDirectory, dataDirectory, edgeProfileDirectory); startErr != nil {
			return startErr
		}
		if waitErr := waitForServer(20 * time.Second); waitErr != nil {
			return waitErr
		}
	}

	edgeExecutable, edgeErr := findEdgeExecutable(localAppData)
	if edgeErr != nil {
		return edgeErr
	}
	extensionDirectory := filepath.Join(installDirectory, "extension")
	if _, statErr := os.Stat(filepath.Join(extensionDirectory, "manifest.json")); statErr != nil {
		return fmt.Errorf("扩展文件不完整: %w", statErr)
	}

	edgeCommand := exec.Command(edgeExecutable,
		"--disable-features=msStartupBoost",
		"--disable-session-crashed-bubble",
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-port=9223",
		"--new-window",
		"--user-data-dir="+edgeProfileDirectory,
		"--disable-extensions-except="+extensionDirectory,
		"--load-extension="+extensionDirectory,
		serverURL,
		"https://www.zhipin.com/web/geek/jobs",
	)
	if startErr := edgeCommand.Start(); startErr != nil {
		return fmt.Errorf("启动专用 Edge 失败: %w", startErr)
	}
	if releaseErr := edgeCommand.Process.Release(); releaseErr != nil {
		return fmt.Errorf("释放 Edge 启动进程失败: %w", releaseErr)
	}
	if extensionErr := waitForExtension(20 * time.Second); extensionErr != nil {
		return extensionErr
	}

	log.Printf("产品启动成功，扩展已自动加载")
	return nil
}

func startService(productRoot string, installDirectory string, dataDirectory string, edgeProfileDirectory string) error {
	serviceExecutable := filepath.Join(installDirectory, "BossJobService.exe")
	if _, statErr := os.Stat(serviceExecutable); statErr != nil {
		return fmt.Errorf("未找到本地服务: %w", statErr)
	}
	serviceLog, logErr := os.OpenFile(filepath.Join(productRoot, "logs", "service.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if logErr != nil {
		return fmt.Errorf("创建服务日志失败: %w", logErr)
	}

	serviceCommand := exec.Command(serviceExecutable)
	serviceCommand.Dir = installDirectory
	serviceCommand.Env = append(os.Environ(),
		"APP_DATA_DIR="+dataDirectory,
		"APP_STATIC_DIR="+filepath.Join(installDirectory, "web"),
		"APP_MEMORY_LIMIT_BYTES=2147483648",
		"BOSS_EDGE_PROFILE_DIR="+edgeProfileDirectory,
		"CODEX_WORKDIR="+dataDirectory,
	)
	serviceCommand.Stdout = serviceLog
	serviceCommand.Stderr = serviceLog
	serviceCommand.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if startErr := serviceCommand.Start(); startErr != nil {
		serviceLog.Close()
		return fmt.Errorf("启动本地服务失败: %w", startErr)
	}
	if releaseErr := serviceCommand.Process.Release(); releaseErr != nil {
		serviceLog.Close()
		return fmt.Errorf("释放本地服务进程失败: %w", releaseErr)
	}
	if closeErr := serviceLog.Close(); closeErr != nil {
		return fmt.Errorf("关闭服务日志失败: %w", closeErr)
	}
	return nil
}

func waitForServer(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if serverHealthy() {
			return nil
		}
		time.Sleep(400 * time.Millisecond)
	}
	return fmt.Errorf("本地服务在 %s 内没有启动，请查看 logs\\service.log", timeout)
}

func serverHealthy() bool {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	response, requestErr := client.Get(serverURL + "/api/health")
	if requestErr != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var health struct {
		Status string `json:"status"`
	}
	if decodeErr := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&health); decodeErr != nil {
		return false
	}
	return health.Status == "ok"
}

func findEdgeExecutable(localAppData string) (string, error) {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
	}
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if fileInfo, statErr := os.Stat(candidate); statErr == nil && !fileInfo.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("未找到 Microsoft Edge，请先安装 Edge 后重试")
}

func waitForExtension(timeout time.Duration) error {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		response, requestErr := client.Get(edgeDebugURL)
		if requestErr == nil {
			var targets []struct {
				Type string `json:"type"`
				URL  string `json:"url"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&targets)
			response.Body.Close()
			if decodeErr == nil {
				for _, target := range targets {
					if target.Type == "service_worker" && strings.HasPrefix(target.URL, "chrome-extension://") && strings.HasSuffix(target.URL, "/background.js") {
						return nil
					}
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("Edge 已打开，但扩展在 %s 内没有加载，请查看 logs\\launcher.log", timeout)
}

func showMessage(title string, message string, flags uintptr) {
	titlePointer, titleErr := syscall.UTF16PtrFromString(title)
	messagePointer, messageErr := syscall.UTF16PtrFromString(message)
	if titleErr != nil || messageErr != nil {
		return
	}
	messageBox := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	_, _, _ = messageBox.Call(
		0,
		uintptr(unsafe.Pointer(messagePointer)),
		uintptr(unsafe.Pointer(titlePointer)),
		flags,
	)
}

//go:build windows

package product

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestIsPathWithinDirectory(t *testing.T) {
	productRoot := `C:\Users\tester\AppData\Local\BossJobCopilot`

	for _, testCase := range []struct {
		name          string
		candidatePath string
		expected      bool
	}{
		{name: "current version service", candidatePath: productRoot + `\app-0.3.9\BossJobService.exe`, expected: true},
		{name: "previous version service", candidatePath: productRoot + `\app-0.3.8\BossJobService.exe`, expected: true},
		{name: "case insensitive path", candidatePath: `c:\users\TESTER\appdata\local\bossjobcopilot\app-0.3.9\BossJobService.exe`, expected: true},
		{name: "similar sibling directory", candidatePath: productRoot + `-backup\app-0.3.9\BossJobService.exe`, expected: false},
		{name: "unrelated executable", candidatePath: `C:\OtherApp\BossJobService.exe`, expected: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if actual := isPathWithinDirectory(testCase.candidatePath, productRoot); actual != testCase.expected {
				t.Fatalf("路径归属判断错误: path=%s actual=%t expected=%t", testCase.candidatePath, actual, testCase.expected)
			}
		})
	}
}

func TestStopRunningServicesReleasesInstalledExecutable(t *testing.T) {
	productRoot := t.TempDir()
	appDirectory := filepath.Join(productRoot, "app-test")
	if makeErr := os.MkdirAll(appDirectory, 0o755); makeErr != nil {
		t.Fatalf("创建测试安装目录失败: %v", makeErr)
	}
	testExecutable, executableErr := os.Executable()
	if executableErr != nil {
		t.Fatalf("读取测试程序路径失败: %v", executableErr)
	}
	serviceExecutable := filepath.Join(appDirectory, serviceExecutableName)
	testBinary, readErr := os.ReadFile(testExecutable)
	if readErr != nil {
		t.Fatalf("读取测试程序失败: %v", readErr)
	}
	if writeErr := os.WriteFile(serviceExecutable, testBinary, 0o755); writeErr != nil {
		t.Fatalf("创建被占用的测试服务失败: %v", writeErr)
	}

	serviceCommand := exec.Command(serviceExecutable, "-test.run=TestProductServiceHelperProcess")
	serviceCommand.Env = append(os.Environ(), "BOSS_JOB_COPILOT_HELPER_PROCESS=1")
	if startErr := serviceCommand.Start(); startErr != nil {
		t.Fatalf("启动测试服务失败: %v", startErr)
	}
	t.Cleanup(func() {
		if serviceCommand.Process != nil {
			_ = serviceCommand.Process.Kill()
			_, _ = serviceCommand.Process.Wait()
		}
	})
	time.Sleep(200 * time.Millisecond)

	if stopErr := StopRunningServices(productRoot, 5*time.Second); stopErr != nil {
		t.Fatalf("停止产品目录内的测试服务失败: %v", stopErr)
	}
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- serviceCommand.Wait()
	}()
	select {
	case <-waitDone:
	case <-time.After(5 * time.Second):
		t.Fatal("测试服务没有按预期退出")
	}

	replacement := []byte("replacement-service")
	if writeErr := os.WriteFile(serviceExecutable, replacement, 0o755); writeErr != nil {
		t.Fatalf("停止服务后仍无法覆盖可执行文件: %v", writeErr)
	}
}

func TestProductServiceHelperProcess(t *testing.T) {
	if os.Getenv("BOSS_JOB_COPILOT_HELPER_PROCESS") != "1" {
		return
	}
	time.Sleep(time.Minute)
}

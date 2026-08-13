package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var ErrMissingCodexCommand = errors.New("未配置 CODEX_COMMAND")

type CodexConfig struct {
	Command string
	Model   string
	WorkDir string
	Timeout time.Duration
}

type CodexClient struct {
	command string
	model   string
	workDir string
	timeout time.Duration
}

func NewCodexClient(config CodexConfig) *CodexClient {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 75 * time.Second
	}
	return &CodexClient{
		command: strings.TrimSpace(config.Command),
		model:   strings.TrimSpace(config.Model),
		workDir: strings.TrimSpace(config.WorkDir),
		timeout: timeout,
	}
}

func (client *CodexClient) Configured() bool {
	if client == nil || strings.TrimSpace(client.command) == "" {
		return false
	}
	return commandAvailable(resolveCodexCommand(client.command))
}

// CheckAvailability 校验本机 Codex CLI 存在且当前登录状态有效，不执行模型请求。
func (client *CodexClient) CheckAvailability(ctx context.Context) error {
	if client == nil || strings.TrimSpace(client.command) == "" {
		return ErrMissingCodexCommand
	}

	command := resolveCodexCommand(client.command)
	if !commandAvailable(command) {
		return fmt.Errorf("未找到可执行的 Codex CLI")
	}

	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(checkCtx, command, "login", "status")
	if client.workDir != "" {
		cmd.Dir = client.workDir
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if runErr := cmd.Run(); runErr != nil {
		if errors.Is(checkCtx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("检查 Codex 登录状态超时: %w", checkCtx.Err())
		}
		return fmt.Errorf("Codex 当前不可用: %w; output=%s", runErr, compactCommandOutput(stdout.String()+" "+stderr.String()))
	}
	return nil
}

func (client *CodexClient) Complete(ctx context.Context, systemPrompt string, userPrompt string) (string, error) {
	if client == nil || strings.TrimSpace(client.command) == "" {
		return "", ErrMissingCodexCommand
	}

	runCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()

	outputFile, createErr := os.CreateTemp("", "boss-codex-reply-*.txt")
	if createErr != nil {
		return "", fmt.Errorf("创建 Codex 输出文件失败: %w", createErr)
	}
	outputPath := outputFile.Name()
	_ = outputFile.Close()
	defer os.Remove(outputPath)

	command, args := client.buildCommand(outputPath)
	if command == "" {
		return "", ErrMissingCodexCommand
	}

	cmd := exec.CommandContext(runCtx, command, args...)
	if client.workDir != "" {
		cmd.Dir = client.workDir
	}
	cmd.Stdin = strings.NewReader(buildCodexPrompt(systemPrompt, userPrompt))

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if runErr := cmd.Run(); runErr != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("调用 Codex 超时: %w", runCtx.Err())
		}
		return "", fmt.Errorf("调用 Codex 失败: %w; stderr=%s; stdout=%s", runErr, compactCommandOutput(stderr.String()), compactCommandOutput(stdout.String()))
	}

	replyBytes, readErr := os.ReadFile(outputPath)
	if readErr != nil {
		return "", fmt.Errorf("读取 Codex 回复失败: %w", readErr)
	}

	reply := cleanCodexCompletion(string(replyBytes))
	if reply == "" {
		reply = cleanCodexCompletion(stdout.String())
	}
	if reply == "" {
		return "", fmt.Errorf("Codex 返回空回复")
	}
	return reply, nil
}

func (client *CodexClient) buildCommand(outputPath string) (string, []string) {
	command := resolveCodexCommand(client.command)
	args := []string{
		"exec",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--sandbox", "read-only",
		"--output-last-message", outputPath,
	}
	if client.workDir != "" {
		args = append(args, "--cd", client.workDir)
	}
	if client.model != "" {
		args = append(args, "--model", client.model)
	}
	args = append(args, "-")
	return command, args
}

func resolveCodexCommand(command string) string {
	cleanCommand := strings.TrimSpace(command)
	if cleanCommand == "" {
		return ""
	}
	if runtime.GOOS == "windows" && strings.EqualFold(cleanCommand, "codex") {
		if configuredCommand := strings.TrimSpace(os.Getenv("CODEX_CLI_PATH")); isRegularFile(configuredCommand) {
			return configuredCommand
		}
		if desktopCommand := findDesktopCodexCommand(os.Getenv("LOCALAPPDATA")); desktopCommand != "" {
			return desktopCommand
		}
		if path, lookErr := exec.LookPath("codex.cmd"); lookErr == nil {
			return path
		}
		if path, lookErr := exec.LookPath("codex.exe"); lookErr == nil {
			return path
		}
	}
	if path, lookErr := exec.LookPath(cleanCommand); lookErr == nil {
		return path
	}
	return cleanCommand
}

func commandAvailable(command string) bool {
	cleanCommand := strings.TrimSpace(command)
	if cleanCommand == "" {
		return false
	}
	if isRegularFile(cleanCommand) {
		return true
	}
	_, lookErr := exec.LookPath(cleanCommand)
	return lookErr == nil
}

// Codex 桌面版会把与当前应用匹配的 CLI 放在版本目录中；优先选择最近更新的版本，
// 避免系统 PATH 中旧版 npm CLI 不认识服务配置的模型。
func findDesktopCodexCommand(localAppData string) string {
	baseDirectory := strings.TrimSpace(localAppData)
	if baseDirectory == "" {
		return ""
	}

	candidates, globErr := filepath.Glob(filepath.Join(baseDirectory, "OpenAI", "Codex", "bin", "*", "codex.exe"))
	if globErr != nil {
		return ""
	}
	directCandidate := filepath.Join(baseDirectory, "OpenAI", "Codex", "bin", "codex.exe")
	if isRegularFile(directCandidate) {
		candidates = append(candidates, directCandidate)
	}

	selectedPath := ""
	var selectedModifiedAt time.Time
	for _, candidate := range candidates {
		info, statErr := os.Stat(candidate)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		if selectedPath == "" || info.ModTime().After(selectedModifiedAt) {
			selectedPath = candidate
			selectedModifiedAt = info.ModTime()
		}
	}
	return selectedPath
}

func isRegularFile(path string) bool {
	cleanPath := strings.TrimSpace(path)
	if cleanPath == "" {
		return false
	}
	info, statErr := os.Stat(cleanPath)
	return statErr == nil && info.Mode().IsRegular()
}

func buildCodexPrompt(systemPrompt string, userPrompt string) string {
	return strings.Join([]string{
		"你是一个只负责生成 BOSS 直聘 HR 聊天回复的文本生成器。",
		"禁止修改文件，禁止运行命令，禁止输出分析过程。",
		"先在内部分析岗位要求、候选人简历事实和当前对话，再只输出一条可直接发送给 HR 的中文回复。",
		"目标是推动简历审核、电话沟通或面试；不要 Markdown，不要编号，不要解释，不要编造简历中没有的信息。",
		"说人话，简短自然，通常 15 到 60 字，最多 80 字。",
		"系统规则：",
		strings.TrimSpace(systemPrompt),
		"岗位、简历和对话上下文：",
		strings.TrimSpace(userPrompt),
	}, "\n\n")
}

func cleanCodexCompletion(content string) string {
	reply := strings.TrimSpace(content)
	if reply == "" {
		return ""
	}

	lines := strings.Split(reply, "\n")
	if len(lines) >= 2 && strings.HasPrefix(strings.TrimSpace(lines[0]), "```") {
		lines = lines[1:]
		if len(lines) > 0 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
			lines = lines[:len(lines)-1]
		}
		reply = strings.TrimSpace(strings.Join(lines, "\n"))
	}

	prefixes := []string{"最终回复：", "最终回复:", "回复：", "回复:", "候选人回复：", "候选人回复:", "可发送内容：", "可发送内容:"}
	for _, prefix := range prefixes {
		reply = strings.TrimSpace(strings.TrimPrefix(reply, prefix))
	}
	reply = strings.Trim(reply, "\"“”'` \t\r\n")
	return strings.Join(strings.Fields(reply), " ")
}

func compactCommandOutput(content string) string {
	cleaned := strings.Join(strings.Fields(strings.TrimSpace(content)), " ")
	if len([]rune(cleaned)) <= 240 {
		return cleaned
	}
	runes := []rune(cleaned)
	return string(runes[:240]) + "..."
}

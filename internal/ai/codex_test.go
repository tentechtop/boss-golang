package ai

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCodexConfiguredRequiresExecutableCommand(t *testing.T) {
	missingCommand := filepath.Join(t.TempDir(), "missing-codex.exe")
	client := NewCodexClient(CodexConfig{Command: missingCommand})
	if client.Configured() {
		t.Fatalf("不存在的 Codex 命令不应被判断为已配置")
	}
	if checkErr := client.CheckAvailability(context.Background()); checkErr == nil {
		t.Fatalf("不存在的 Codex 命令不应通过可用性检查")
	}
}

func TestCleanCodexCompletionRemovesFenceAndPrefix(t *testing.T) {
	got := cleanCodexCompletion("```text\n最终回复：您好，我对这个岗位比较感兴趣，可以进一步沟通。\n```")
	want := "您好，我对这个岗位比较感兴趣，可以进一步沟通。"
	if got != want {
		t.Fatalf("清理 Codex 输出失败: got=%q want=%q", got, want)
	}
}

func TestBuildCodexPromptRequiresFinalReplyOnly(t *testing.T) {
	prompt := buildCodexPrompt("系统规则", "岗位上下文")
	for _, want := range []string{"只输出一条可直接发送给 HR 的中文回复", "禁止修改文件", "岗位上下文"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("Codex prompt 缺少关键约束 %q: %s", want, prompt)
		}
	}
}

// 功能目的：锁定当前 Codex CLI 的非交互参数；实现原因：0.139.0 已移除 exec 的 --ask-for-approval 参数。
func TestBuildCodexCommandUsesSupportedExecFlags(t *testing.T) {
	client := NewCodexClient(CodexConfig{Command: "codex-test-command", WorkDir: t.TempDir()})
	_, args := client.buildCommand("reply.txt")
	if slices.Contains(args, "--ask-for-approval") {
		t.Fatalf("Codex exec 不应再传入已移除的 --ask-for-approval 参数: %#v", args)
	}
	for _, expected := range []string{"exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--output-last-message", "reply.txt"} {
		if !slices.Contains(args, expected) {
			t.Fatalf("Codex exec 缺少参数 %q: %#v", expected, args)
		}
	}
}

func TestBuildCodexCommandUsesConfiguredGPT56Model(t *testing.T) {
	client := NewCodexClient(CodexConfig{
		Command: "codex-test-command",
		Model:   "gpt-5.6-sol",
		WorkDir: t.TempDir(),
	})

	_, args := client.buildCommand("reply.txt")
	modelFlagIndex := slices.Index(args, "--model")
	if modelFlagIndex < 0 || modelFlagIndex+1 >= len(args) {
		t.Fatalf("Codex 命令缺少模型参数: %#v", args)
	}
	if args[modelFlagIndex+1] != "gpt-5.6-sol" {
		t.Fatalf("Codex 模型错误: %s", args[modelFlagIndex+1])
	}
}

func TestFindDesktopCodexCommandUsesNewestVersion(t *testing.T) {
	localAppData := t.TempDir()
	olderCommand := filepath.Join(localAppData, "OpenAI", "Codex", "bin", "old", "codex.exe")
	newerCommand := filepath.Join(localAppData, "OpenAI", "Codex", "bin", "new", "codex.exe")
	for _, command := range []string{olderCommand, newerCommand} {
		if mkdirErr := os.MkdirAll(filepath.Dir(command), 0o755); mkdirErr != nil {
			t.Fatal(mkdirErr)
		}
		if writeErr := os.WriteFile(command, []byte("test"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	olderTime := time.Now().Add(-time.Hour)
	if chtimesErr := os.Chtimes(olderCommand, olderTime, olderTime); chtimesErr != nil {
		t.Fatal(chtimesErr)
	}

	if got := findDesktopCodexCommand(localAppData); got != newerCommand {
		t.Fatalf("桌面 Codex CLI 选择错误: got=%q want=%q", got, newerCommand)
	}
}

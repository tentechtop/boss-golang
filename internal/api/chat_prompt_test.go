package api

import (
	"strings"
	"testing"

	"boss-job-assistant/internal/domain"
)

func TestBuildDeepSeekChatPromptAdvancesJobSearchWithVerifiedContext(t *testing.T) {
	strategy := domain.DefaultDeliveryStrategy()
	strategy.IncludeTitleKeywords = []string{"区块链"}
	jobAnalysis := domain.JobAnalysis{
		Title:       "区块链后端开发工程师",
		Company:     "测试公司",
		Location:    "深圳",
		Salary:      "25-35K",
		Description: "负责 Go、gRPC 和 MySQL 服务开发",
	}

	prompt := buildDeepSeekChatPrompt(jobAnalysis, nil, []domain.Message{{
		Role:    "recruiter",
		Content: "方便聊聊吗？",
	}}, "积极主动", strategy)

	for _, expected := range []string{
		"负责 Go、gRPC 和 MySQL 服务开发",
		"主要求职方向：区块链",
		"目标城市：深圳市",
		"期望月薪不低于：25K",
		"优先推进到简历审核、电话沟通或面试安排",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("聊天提示缺少求职推进上下文 %q", expected)
		}
	}
}

func TestPendingRecruiterMessagesIncludesEveryQuestionAfterCandidateReply(t *testing.T) {
	messages := []domain.Message{
		{Role: "recruiter", Content: "学历是本科吗？"},
		{Role: "candidate", Content: "是的，本科。"},
		{Role: "recruiter", Content: "1. Go 做了几年？"},
		{Role: "recruiter", Content: "2. 做过支付结算吗？"},
		{Role: "recruiter", Content: "可以发一份简历吗？"},
	}

	pendingMessages := pendingRecruiterMessages(messages)
	if len(pendingMessages) != 3 {
		t.Fatalf("待答 HR 消息数量 = %d，期望 3", len(pendingMessages))
	}
	for index, expected := range []string{"1. Go 做了几年？", "2. 做过支付结算吗？", "可以发一份简历吗？"} {
		if pendingMessages[index] != expected {
			t.Fatalf("待答 HR 消息 %d = %q，期望 %q", index, pendingMessages[index], expected)
		}
	}

	prompt := buildDeepSeekChatPrompt(domain.JobAnalysis{Title: "Golang 后端工程师"}, nil, messages, "积极主动", domain.DefaultDeliveryStrategy())
	for _, expected := range []string{
		"本轮必须逐项处理的 HR 消息",
		"HR待答1：1. Go 做了几年？",
		"HR待答2：2. 做过支付结算吗？",
		"HR待答3：可以发一份简历吗？",
		"不得只回复最后一条",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("聊天提示缺少多问题处理要求 %q", expected)
		}
	}
}

func TestBuildDeepSeekChatPromptRequiresRespectfulNaturalThanks(t *testing.T) {
	prompt := buildDeepSeekChatPrompt(
		domain.JobAnalysis{Title: "Golang 后端工程师", Company: "测试公司"},
		nil,
		[]domain.Message{{Role: "recruiter", Content: "方便发一份简历吗？"}},
		"积极主动",
		domain.DefaultDeliveryStrategy(),
	)

	for _, expected := range []string{
		"对HR提供的信息、时间或沟通机会自然表达感谢",
		"对贵司和岗位保持尊重",
		"每条最多一次",
		"不要奉承、卑微、客服腔或公文腔",
		"礼貌感谢并简短确认已经发送",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("聊天提示缺少尊重且自然的感谢约束 %q", expected)
		}
	}
}

func TestSanitizeResumeForChatPromptRemovesCredentialLines(t *testing.T) {
	resumeMarkdown := "技能：Go、gRPC、MySQL\nmysqlPassword: secret-value\nAPI_KEY=hidden-value\n项目：分佣结算"
	promptResume := sanitizeResumeForChatPrompt(resumeMarkdown)

	for _, expected := range []string{"技能：Go、gRPC、MySQL", "项目：分佣结算"} {
		if !strings.Contains(promptResume, expected) {
			t.Fatalf("过滤后缺少正常简历内容 %q: %s", expected, promptResume)
		}
	}
	for _, forbidden := range []string{"secret-value", "hidden-value", "mysqlPassword", "API_KEY"} {
		if strings.Contains(promptResume, forbidden) {
			t.Fatalf("敏感配置仍进入聊天提示 %q: %s", forbidden, promptResume)
		}
	}
}

package resume

import (
	"strings"
	"testing"

	"boss-job-assistant/internal/domain"
)

func TestGenerateResumeUsesProjectEvidence(t *testing.T) {
	profile := domain.CandidateProfile{
		Name:       "测试用户",
		TargetRole: "Go 后端开发",
		Skills:     []string{"Go", "Redis"},
	}
	projects := []domain.ProjectSummary{
		{
			ID:             "project_1",
			Name:           "demo",
			BusinessDomain: "AI 应用",
			TechStack:      []string{"Go", "Redis"},
			CoreModules:    []string{"internal"},
			Highlights:     []string{"基于现有项目证据识别技术栈：Go、Redis"},
		},
	}

	resumeVersion, generateErr := Generate(profile, projects, nil)
	if generateErr != nil {
		t.Fatalf("生成简历失败: %v", generateErr)
	}

	if !strings.Contains(resumeVersion.Markdown, "demo") {
		t.Fatalf("简历缺少项目名称")
	}
	if !strings.Contains(resumeVersion.HTML, "<html") {
		t.Fatalf("简历 HTML 未生成")
	}
}

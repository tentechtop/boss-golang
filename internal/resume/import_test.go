package resume

import (
	"strings"
	"testing"

	"boss-job-assistant/internal/domain"
)

// 导入简历测试：校验文本导入能提取关键字段；实现原因：无障碍流程依赖粘贴简历直接产出可用上下文。
func TestImportFromTextExtractsProfileFields(t *testing.T) {
	resumeText := `
姓名：测试用户
求职意向：Go 后端工程师
所在城市：示例城市
工作经验：6年
邮箱：test@example.com
手机：138 0013 8000
专业技能：Go、Redis、MySQL、Docker、Kubernetes
教育经历：示例大学 计算机科学与技术 本科
`

	resumeVersion, importError := ImportFromText(resumeText, domain.CandidateProfile{})
	if importError != nil {
		t.Fatalf("导入简历失败: %v", importError)
	}

	if resumeVersion.Profile.Name != "测试用户" {
		t.Fatalf("姓名提取错误: %#v", resumeVersion.Profile)
	}
	if resumeVersion.Profile.TargetRole != "Go 后端工程师" {
		t.Fatalf("目标岗位提取错误: %#v", resumeVersion.Profile)
	}
	if resumeVersion.Profile.Location != "示例城市" {
		t.Fatalf("城市提取错误: %#v", resumeVersion.Profile)
	}
	if resumeVersion.Profile.Phone != "13800138000" {
		t.Fatalf("手机号标准化错误: %#v", resumeVersion.Profile)
	}
	if !strings.Contains(resumeVersion.Markdown, "Go") || !strings.Contains(resumeVersion.Markdown, "Kubernetes") {
		t.Fatalf("技能未进入导入简历内容: %s", resumeVersion.Markdown)
	}
}

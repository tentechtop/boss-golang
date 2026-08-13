package resume

import (
	"bytes"
	"fmt"
	"html"
	"html/template"
	"strings"
	"time"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/utils"
)

// 生成简历：基于项目证据组织内容，避免自动编造经历指标。
func Generate(profile domain.CandidateProfile, projects []domain.ProjectSummary, targetJob *domain.JobAnalysis) (domain.ResumeVersion, error) {
	if strings.TrimSpace(profile.Name) == "" {
		return domain.ResumeVersion{}, fmt.Errorf("姓名不能为空")
	}
	if strings.TrimSpace(profile.TargetRole) == "" {
		return domain.ResumeVersion{}, fmt.Errorf("求职意向不能为空")
	}
	if len(projects) == 0 {
		return domain.ResumeVersion{}, fmt.Errorf("至少需要一个项目生成简历")
	}

	resumeID, idErr := utils.NewID("resume")
	if idErr != nil {
		return domain.ResumeVersion{}, idErr
	}

	projectIDs := make([]string, 0, len(projects))
	for _, projectSummary := range projects {
		projectIDs = append(projectIDs, projectSummary.ID)
	}

	resumeName := buildResumeName(profile.TargetRole, targetJob)
	markdown := buildMarkdown(profile, projects, targetJob)
	htmlContent, htmlErr := markdownToHTML(markdown)
	if htmlErr != nil {
		return domain.ResumeVersion{}, htmlErr
	}

	targetJobID := ""
	if targetJob != nil {
		targetJobID = targetJob.ID
	}

	return domain.ResumeVersion{
		ID:          resumeID,
		Name:        resumeName,
		Profile:     profile,
		ProjectIDs:  projectIDs,
		TargetJobID: targetJobID,
		Markdown:    markdown,
		HTML:        htmlContent,
		CreatedAt:   time.Now(),
	}, nil
}

func buildResumeName(targetRole string, targetJob *domain.JobAnalysis) string {
	if targetJob == nil || len(targetJob.Keywords) == 0 {
		return utils.CleanText(targetRole, 20) + "-基础版"
	}

	keywordLimit := 3
	if len(targetJob.Keywords) < keywordLimit {
		keywordLimit = len(targetJob.Keywords)
	}
	return utils.CleanText(targetRole, 20) + "-" + strings.Join(targetJob.Keywords[:keywordLimit], "-") + "版"
}

func buildMarkdown(profile domain.CandidateProfile, projects []domain.ProjectSummary, targetJob *domain.JobAnalysis) string {
	var builder strings.Builder
	builder.WriteString("# " + profile.Name + "\n\n")
	builder.WriteString("- 求职意向：" + safeValue(profile.TargetRole) + "\n")
	builder.WriteString("- 工作年限：" + safeValue(profile.YearsExperience) + "\n")
	builder.WriteString("- 所在城市：" + safeValue(profile.Location) + "\n")
	builder.WriteString("- 邮箱：" + safeValue(profile.Email) + "\n")
	builder.WriteString("- 手机：" + safeValue(profile.Phone) + "\n\n")

	builder.WriteString("## 技能栈\n\n")
	skills := buildSkills(profile, projects, targetJob)
	for _, skill := range skills {
		builder.WriteString("- " + skill + "\n")
	}

	builder.WriteString("\n## 项目经历\n\n")
	for _, projectSummary := range projects {
		writeProject(&builder, projectSummary, targetJob)
	}

	builder.WriteString("## 教育经历\n\n")
	builder.WriteString("- " + safeValue(profile.Education) + "\n\n")

	builder.WriteString("## 说明\n\n")
	builder.WriteString("- 本简历仅基于用户输入和本地项目扫描证据生成，未自动编造经历、指标或任职信息。\n")
	return builder.String()
}

func buildSkills(profile domain.CandidateProfile, projects []domain.ProjectSummary, targetJob *domain.JobAnalysis) []string {
	skills := append([]string{}, profile.Skills...)
	for _, projectSummary := range projects {
		skills = append(skills, projectSummary.TechStack...)
	}

	if targetJob != nil {
		matchedSkills := utils.IntersectFold(skills, targetJob.Keywords)
		orderedSkills := append([]string{}, matchedSkills...)
		orderedSkills = append(orderedSkills, skills...)
		return utils.UniqueNonEmpty(orderedSkills)
	}

	return utils.UniqueNonEmpty(skills)
}

func writeProject(builder *strings.Builder, projectSummary domain.ProjectSummary, targetJob *domain.JobAnalysis) {
	builder.WriteString("### " + projectSummary.Name + "\n\n")
	builder.WriteString("- 业务领域：" + safeValue(projectSummary.BusinessDomain) + "\n")
	if len(projectSummary.TechStack) > 0 {
		builder.WriteString("- 技术栈：" + strings.Join(projectSummary.TechStack, "、") + "\n")
	}
	if len(projectSummary.CoreModules) > 0 {
		builder.WriteString("- 核心模块：" + strings.Join(projectSummary.CoreModules, "、") + "\n")
	}

	for _, highlight := range projectSummary.Highlights {
		builder.WriteString("- " + highlight + "\n")
	}

	if targetJob != nil {
		matches := utils.IntersectFold(projectSummary.TechStack, targetJob.Keywords)
		if len(matches) > 0 {
			builder.WriteString("- 岗位匹配表达：该项目可重点突出 " + strings.Join(matches, "、") + " 相关经验。\n")
		}
	}

	builder.WriteString("\n")
}

func markdownToHTML(markdown string) (string, error) {
	lines := strings.Split(markdown, "\n")
	var body strings.Builder
	inList := false

	for _, line := range lines {
		trimmedLine := strings.TrimSpace(line)
		if trimmedLine == "" {
			if inList {
				body.WriteString("</ul>\n")
				inList = false
			}
			continue
		}

		if strings.HasPrefix(trimmedLine, "### ") {
			closeList(&body, &inList)
			body.WriteString("<h3>" + html.EscapeString(strings.TrimPrefix(trimmedLine, "### ")) + "</h3>\n")
			continue
		}
		if strings.HasPrefix(trimmedLine, "## ") {
			closeList(&body, &inList)
			body.WriteString("<h2>" + html.EscapeString(strings.TrimPrefix(trimmedLine, "## ")) + "</h2>\n")
			continue
		}
		if strings.HasPrefix(trimmedLine, "# ") {
			closeList(&body, &inList)
			body.WriteString("<h1>" + html.EscapeString(strings.TrimPrefix(trimmedLine, "# ")) + "</h1>\n")
			continue
		}
		if strings.HasPrefix(trimmedLine, "- ") {
			if !inList {
				body.WriteString("<ul>\n")
				inList = true
			}
			body.WriteString("<li>" + html.EscapeString(strings.TrimPrefix(trimmedLine, "- ")) + "</li>\n")
			continue
		}
		closeList(&body, &inList)
		body.WriteString("<p>" + html.EscapeString(trimmedLine) + "</p>\n")
	}
	closeList(&body, &inList)

	pageTemplate := template.Must(template.New("resume").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>简历</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.65;color:#1f2937;max-width:860px;margin:40px auto;padding:0 24px}
h1{font-size:30px;margin-bottom:8px}h2{border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin-top:28px}h3{margin-top:22px}
li{margin:5px 0}
</style>
</head>
<body>
{{.Body}}
</body>
</html>`))

	var page bytes.Buffer
	if executeErr := pageTemplate.Execute(&page, map[string]template.HTML{
		"Body": template.HTML(body.String()),
	}); executeErr != nil {
		return "", fmt.Errorf("渲染简历 HTML 失败: %w", executeErr)
	}

	return page.String(), nil
}

func closeList(builder *strings.Builder, inList *bool) {
	if *inList {
		builder.WriteString("</ul>\n")
		*inList = false
	}
}

func safeValue(value string) string {
	cleanedValue := strings.TrimSpace(value)
	if cleanedValue == "" {
		return "待补充"
	}
	return cleanedValue
}

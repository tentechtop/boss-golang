package resume

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/utils"
)

var importedResumeEmailPattern = regexp.MustCompile(`(?i)[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}`)

var importedResumePhonePattern = regexp.MustCompile(`(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})`)

var importedResumeYearsPattern = regexp.MustCompile(`\d{1,2}\+?\s*年(?:以上)?`)

var importedResumeLabelPatterns = map[string][]*regexp.Regexp{
	"name": {
		regexp.MustCompile(`(?m)^(?:姓名|名字|Name)\s*[:：]\s*(.+)$`),
	},
	"role": {
		regexp.MustCompile(`(?m)^(?:求职意向|目标岗位|应聘岗位|意向岗位|期望岗位|求职岗位)\s*[:：]\s*(.+)$`),
	},
	"location": {
		regexp.MustCompile(`(?m)^(?:所在地|所在城市|现居地|现居住地|工作城市|目标城市)\s*[:：]\s*(.+)$`),
	},
	"education": {
		regexp.MustCompile(`(?m)^(?:教育经历|学历|毕业院校)\s*[:：]\s*(.+)$`),
	},
	"experience": {
		regexp.MustCompile(`(?m)^(?:工作经验|从业年限|经验年限)\s*[:：]\s*(.+)$`),
	},
	"skills": {
		regexp.MustCompile(`(?m)^(?:技能标签|技能|专业技能|核心技能|技术栈|擅长技术|掌握技术)\s*[:：]\s*(.+)$`),
	},
}

var importedResumeSkillKeywords = []string{
	"Go",
	"Golang",
	"Java",
	"Python",
	"JavaScript",
	"TypeScript",
	"Node.js",
	"React",
	"Vue",
	"MySQL",
	"PostgreSQL",
	"Redis",
	"MongoDB",
	"Elasticsearch",
	"Kafka",
	"RabbitMQ",
	"gRPC",
	"HTTP",
	"RESTful",
	"GraphQL",
	"Docker",
	"Kubernetes",
	"Linux",
	"Nginx",
	"AWS",
	"Azure",
	"GCP",
	"Git",
	"微服务",
	"分布式",
	"高并发",
	"消息队列",
	"系统设计",
}

// 导入简历：接收粘贴简历文本；实现原因：让无障碍模式不依赖项目扫描也能直接进入自动求职链路。
func ImportFromText(resumeText string, overrides domain.CandidateProfile) (domain.ResumeVersion, error) {
	normalizedResumeText := normalizeImportedResumeText(resumeText)
	if normalizedResumeText == "" {
		return domain.ResumeVersion{}, fmt.Errorf("简历内容不能为空")
	}

	profile := buildImportedProfile(normalizedResumeText, overrides)
	if strings.TrimSpace(profile.TargetRole) == "" {
		return domain.ResumeVersion{}, fmt.Errorf("目标岗位不能为空")
	}

	resumeID, idErr := utils.NewID("resume")
	if idErr != nil {
		return domain.ResumeVersion{}, fmt.Errorf("生成导入简历 ID 失败: %w", idErr)
	}

	markdown := buildImportedMarkdown(profile, normalizedResumeText)
	htmlContent, htmlErr := markdownToHTML(markdown)
	if htmlErr != nil {
		return domain.ResumeVersion{}, fmt.Errorf("渲染导入简历 HTML 失败: %w", htmlErr)
	}

	return domain.ResumeVersion{
		ID:         resumeID,
		Name:       buildImportedResumeName(profile),
		Profile:    profile,
		ProjectIDs: []string{},
		Markdown:   markdown,
		HTML:       htmlContent,
		CreatedAt:  time.Now(),
	}, nil
}

func buildImportedProfile(resumeText string, overrides domain.CandidateProfile) domain.CandidateProfile {
	profile := domain.CandidateProfile{
		Name:            cleanImportedField(overrides.Name, 30),
		TargetRole:      cleanImportedField(overrides.TargetRole, 60),
		Email:           cleanImportedField(overrides.Email, 120),
		Phone:           cleanImportedField(overrides.Phone, 30),
		Location:        cleanImportedField(overrides.Location, 40),
		Education:       cleanImportedField(overrides.Education, 120),
		YearsExperience: cleanImportedField(overrides.YearsExperience, 40),
		Skills:          utils.UniqueNonEmpty(limitImportedSkills(overrides.Skills)),
	}

	if profile.Name == "" {
		profile.Name = extractImportedName(resumeText)
	}
	if profile.Name == "" {
		profile.Name = "候选人"
	}
	if profile.TargetRole == "" {
		profile.TargetRole = cleanImportedField(extractImportedLabeledValue("role", resumeText), 60)
	}
	if profile.Email == "" {
		profile.Email = cleanImportedField(importedResumeEmailPattern.FindString(resumeText), 120)
	}
	if profile.Phone == "" {
		profile.Phone = cleanImportedField(normalizeImportedPhone(importedResumePhonePattern.FindString(resumeText)), 30)
	}
	if profile.Location == "" {
		profile.Location = cleanImportedField(extractImportedLabeledValue("location", resumeText), 40)
	}
	if profile.Education == "" {
		profile.Education = cleanImportedField(extractImportedEducation(resumeText), 120)
	}
	if profile.YearsExperience == "" {
		profile.YearsExperience = cleanImportedField(extractImportedYearsExperience(resumeText), 40)
	}
	profile.Skills = utils.UniqueNonEmpty(append(profile.Skills, extractImportedSkills(resumeText)...))
	return profile
}

func buildImportedResumeName(profile domain.CandidateProfile) string {
	if strings.TrimSpace(profile.TargetRole) == "" {
		return "导入简历"
	}
	return buildResumeName(profile.TargetRole, nil)
}

func buildImportedMarkdown(profile domain.CandidateProfile, resumeText string) string {
	var builder strings.Builder
	builder.WriteString("# " + safeValue(profile.Name) + "\n\n")
	builder.WriteString("- 求职意向：" + safeValue(profile.TargetRole) + "\n")
	builder.WriteString("- 所在城市：" + safeValue(profile.Location) + "\n")
	builder.WriteString("- 工作年限：" + safeValue(profile.YearsExperience) + "\n")
	builder.WriteString("- 邮箱：" + safeValue(profile.Email) + "\n")
	builder.WriteString("- 手机：" + safeValue(profile.Phone) + "\n")
	builder.WriteString("- 学历：" + safeValue(profile.Education) + "\n\n")

	builder.WriteString("## 技能标签\n\n")
	for _, skill := range profile.Skills {
		builder.WriteString("- " + skill + "\n")
	}
	if len(profile.Skills) == 0 {
		builder.WriteString("- 待补充\n")
	}

	builder.WriteString("\n## 原始简历\n\n")
	for _, line := range selectImportedResumeLines(resumeText) {
		builder.WriteString("- " + line + "\n")
	}

	builder.WriteString("\n## 说明\n\n")
	builder.WriteString("- 本简历由用户粘贴的原始文本导入生成，未自动编造项目经历、指标或任职信息。\n")
	return builder.String()
}

func normalizeImportedResumeText(resumeText string) string {
	lines := strings.Split(strings.ReplaceAll(resumeText, "\r\n", "\n"), "\n")
	normalizedLines := make([]string, 0, len(lines))
	totalRunes := 0
	for _, line := range lines {
		cleanedLine := strings.TrimSpace(line)
		if cleanedLine == "" {
			if len(normalizedLines) == 0 || normalizedLines[len(normalizedLines)-1] == "" {
				continue
			}
			normalizedLines = append(normalizedLines, "")
			continue
		}

		lineRunes := []rune(cleanedLine)
		if len(lineRunes) > 240 {
			cleanedLine = string(lineRunes[:240])
			lineRunes = []rune(cleanedLine)
		}
		if totalRunes+len(lineRunes) > 8000 {
			remainingRunes := 8000 - totalRunes
			if remainingRunes <= 0 {
				break
			}
			cleanedLine = string(lineRunes[:remainingRunes])
			lineRunes = []rune(cleanedLine)
		}
		normalizedLines = append(normalizedLines, cleanedLine)
		totalRunes += len(lineRunes)
		if totalRunes >= 8000 {
			break
		}
	}
	return strings.TrimSpace(strings.Join(normalizedLines, "\n"))
}

func extractImportedName(resumeText string) string {
	labeledName := cleanImportedField(extractImportedLabeledValue("name", resumeText), 30)
	if labeledName != "" {
		return labeledName
	}

	for _, line := range strings.Split(resumeText, "\n") {
		cleanedLine := strings.TrimSpace(line)
		if !isLikelyImportedNameLine(cleanedLine) {
			continue
		}
		return cleanImportedField(cleanedLine, 30)
	}
	return ""
}

func extractImportedEducation(resumeText string) string {
	labeledEducation := cleanImportedField(extractImportedLabeledValue("education", resumeText), 120)
	if labeledEducation != "" {
		return labeledEducation
	}

	for _, line := range strings.Split(resumeText, "\n") {
		cleanedLine := strings.TrimSpace(line)
		if cleanedLine == "" {
			continue
		}
		if strings.Contains(cleanedLine, "本科") || strings.Contains(cleanedLine, "硕士") || strings.Contains(cleanedLine, "博士") || strings.Contains(cleanedLine, "大专") {
			return cleanImportedField(cleanedLine, 120)
		}
	}
	return ""
}

func extractImportedYearsExperience(resumeText string) string {
	labeledYearsExperience := cleanImportedField(extractImportedLabeledValue("experience", resumeText), 40)
	if labeledYearsExperience != "" {
		return labeledYearsExperience
	}
	return cleanImportedField(importedResumeYearsPattern.FindString(resumeText), 40)
}

func extractImportedSkills(resumeText string) []string {
	skills := make([]string, 0, 12)
	labeledSkills := extractImportedLabeledValue("skills", resumeText)
	if labeledSkills != "" {
		skills = append(skills, splitImportedSkills(labeledSkills)...)
	}

	lowerResumeText := strings.ToLower(resumeText)
	for _, skillKeyword := range importedResumeSkillKeywords {
		if strings.Contains(lowerResumeText, strings.ToLower(skillKeyword)) {
			skills = append(skills, skillKeyword)
		}
	}
	return utils.UniqueNonEmpty(limitImportedSkills(skills))
}

func selectImportedResumeLines(resumeText string) []string {
	lines := strings.Split(resumeText, "\n")
	selectedLines := make([]string, 0, len(lines))
	totalRunes := 0
	for _, line := range lines {
		cleanedLine := strings.TrimSpace(line)
		if cleanedLine == "" {
			continue
		}
		lineRunes := []rune(cleanedLine)
		if totalRunes+len(lineRunes) > 5000 {
			remainingRunes := 5000 - totalRunes
			if remainingRunes <= 0 {
				break
			}
			cleanedLine = string(lineRunes[:remainingRunes])
			lineRunes = []rune(cleanedLine)
		}
		selectedLines = append(selectedLines, cleanImportedMarkdownLine(cleanedLine))
		totalRunes += len(lineRunes)
		if len(selectedLines) >= 60 || totalRunes >= 5000 {
			break
		}
	}
	return selectedLines
}

func extractImportedLabeledValue(label string, resumeText string) string {
	patterns, exists := importedResumeLabelPatterns[label]
	if !exists {
		return ""
	}

	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(resumeText)
		if len(matches) < 2 {
			continue
		}
		return strings.TrimSpace(matches[1])
	}
	return ""
}

func splitImportedSkills(rawSkills string) []string {
	fields := strings.FieldsFunc(rawSkills, func(char rune) bool {
		switch char {
		case ',', '，', '、', ';', '；', '/', '|', '·':
			return true
		}
		return unicode.IsSpace(char)
	})

	skills := make([]string, 0, len(fields))
	for _, field := range fields {
		cleanedField := cleanImportedField(field, 30)
		if cleanedField == "" {
			continue
		}
		skills = append(skills, cleanedField)
	}
	return skills
}

func limitImportedSkills(skills []string) []string {
	limitedSkills := make([]string, 0, len(skills))
	for _, skill := range skills {
		cleanedSkill := cleanImportedField(skill, 30)
		if cleanedSkill == "" {
			continue
		}
		limitedSkills = append(limitedSkills, cleanedSkill)
		if len(limitedSkills) >= 20 {
			break
		}
	}
	return limitedSkills
}

func normalizeImportedPhone(phone string) string {
	replacer := strings.NewReplacer(" ", "", "-", "")
	return replacer.Replace(strings.TrimSpace(phone))
}

func cleanImportedField(value string, maxLength int) string {
	return utils.CleanText(value, maxLength)
}

func cleanImportedMarkdownLine(line string) string {
	cleanedLine := strings.ReplaceAll(line, "\t", " ")
	if strings.HasPrefix(cleanedLine, "-") {
		return strings.TrimSpace(strings.TrimPrefix(cleanedLine, "-"))
	}
	return cleanedLine
}

func isLikelyImportedNameLine(line string) bool {
	if line == "" {
		return false
	}
	if strings.ContainsAny(line, "@:：0123456789") {
		return false
	}
	if strings.Contains(line, "简历") || strings.Contains(strings.ToLower(line), "resume") {
		return false
	}
	lineRunes := []rune(line)
	if len(lineRunes) < 2 || len(lineRunes) > 12 {
		return false
	}
	return true
}

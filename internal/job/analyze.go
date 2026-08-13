package job

import (
	"fmt"
	"strings"
	"time"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/utils"
)

var knownJobKeywords = []string{
	"Go", "Golang", "Java", "Python", "Node.js", "React", "Vue", "TypeScript",
	"MySQL", "Redis", "Kafka", "MongoDB", "PostgreSQL", "Elasticsearch",
	"Docker", "Kubernetes", "K8s", "微服务", "分布式", "高并发", "Linux",
	"HTTP", "gRPC", "消息队列", "缓存", "数据库", "性能优化", "监控", "日志",
}

// 分析岗位：提取硬性要求和缺口，方便用户判断是否值得投递。
func Analyze(description string, title string, company string, candidateSkills []string) (domain.JobAnalysis, error) {
	cleanDescription := utils.CleanText(description, 12000)
	if cleanDescription == "" {
		return domain.JobAnalysis{}, fmt.Errorf("岗位 JD 不能为空")
	}

	jobID, idErr := utils.NewID("job")
	if idErr != nil {
		return domain.JobAnalysis{}, idErr
	}

	keywords := extractKeywords(cleanDescription)
	missingSkills := calculateMissingSkills(keywords, candidateSkills)
	score := calculateMatchScore(keywords, missingSkills)

	return domain.JobAnalysis{
		ID:               jobID,
		Title:            utils.CleanText(title, 80),
		Company:          utils.CleanText(company, 80),
		Description:      cleanDescription,
		Keywords:         keywords,
		HardRequirements: extractRequirementLines(cleanDescription, []string{"必须", "熟悉", "掌握", "精通", "经验", "要求"}),
		BonusItems:       extractRequirementLines(cleanDescription, []string{"加分", "优先", "熟悉"}),
		MissingSkills:    missingSkills,
		Risks:            extractRisks(cleanDescription),
		MatchScore:       score,
		Recommendation:   buildRecommendation(score, missingSkills),
		CreatedAt:        time.Now(),
	}, nil
}

func extractKeywords(description string) []string {
	keywords := make([]string, 0)
	for _, keyword := range knownJobKeywords {
		if utils.ContainsAnyFold(description, []string{keyword}) {
			keywords = append(keywords, keyword)
		}
	}
	return utils.UniqueNonEmpty(keywords)
}

func calculateMissingSkills(jobKeywords []string, candidateSkills []string) []string {
	candidateSet := make(map[string]struct{}, len(candidateSkills))
	for _, skill := range candidateSkills {
		candidateSet[strings.ToLower(strings.TrimSpace(skill))] = struct{}{}
	}

	missingSkills := make([]string, 0)
	for _, keyword := range jobKeywords {
		if _, exists := candidateSet[strings.ToLower(keyword)]; !exists {
			missingSkills = append(missingSkills, keyword)
		}
	}

	return utils.UniqueNonEmpty(missingSkills)
}

func calculateMatchScore(jobKeywords []string, missingSkills []string) int {
	if len(jobKeywords) == 0 {
		return 60
	}

	matchedCount := len(jobKeywords) - len(missingSkills)
	score := 50 + matchedCount*50/len(jobKeywords)
	if score < 0 {
		return 0
	}
	if score > 100 {
		return 100
	}
	return score
}

func extractRequirementLines(description string, markers []string) []string {
	lines := splitReadableLines(description)
	requirements := make([]string, 0)
	for _, line := range lines {
		if utils.ContainsAnyFold(line, markers) {
			requirements = append(requirements, utils.CleanText(line, 140))
		}
		if len(requirements) >= 8 {
			break
		}
	}
	return utils.UniqueNonEmpty(requirements)
}

func extractRisks(description string) []string {
	risks := make([]string, 0)
	if utils.ContainsAnyFold(description, []string{"996", "大小周", "抗压", "狼性"}) {
		risks = append(risks, "岗位描述包含高强度工作信号，建议沟通作息和团队节奏")
	}
	if utils.ContainsAnyFold(description, []string{"外包", "驻场"}) {
		risks = append(risks, "岗位可能涉及外包或驻场，建议确认合同主体和办公方式")
	}
	if len(risks) == 0 {
		risks = append(risks, "暂未识别明显风险，仍建议面试前确认职责边界")
	}
	return risks
}

func splitReadableLines(description string) []string {
	replacer := strings.NewReplacer("。", "\n", "；", "\n", ";", "\n", "，", "\n")
	rawLines := strings.Split(replacer.Replace(description), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, rawLine := range rawLines {
		line := utils.CleanText(rawLine, 180)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func buildRecommendation(score int, missingSkills []string) string {
	if score >= 85 {
		return "高匹配，建议优先投递并突出命中关键词"
	}
	if score >= 70 {
		return "中高匹配，建议补强缺口表达后投递"
	}
	if score >= 55 {
		return "一般匹配，建议确认核心要求后谨慎投递"
	}
	return "匹配度偏低，建议除非岗位有明显吸引力否则暂缓"
}

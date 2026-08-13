package chat

import (
	"fmt"
	"strings"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/utils"
)

// 生成话术：结合岗位和简历事实，根据对话上下文生成恰当的下一句回复。
func Suggest(jobAnalysis domain.JobAnalysis, resumeVersion *domain.ResumeVersion, messages []domain.Message, mode string) domain.ChatSuggestion {
	cleanMode := utils.CleanText(mode, 20)
	if cleanMode == "" {
		cleanMode = "专业稳重"
	}

	// 分析对话上下文：获取HR最后一条消息、对话轮次、HR提问倾向
	lastRecruiterMsg := latestRecruiterQuestion(messages)
	recruiterCount, candidateCount := countMessagesByRole(messages)
	isFirstRound := recruiterCount <= 1 && candidateCount <= 1
	hasHrAskedQuestion := detectHrQuestion(lastRecruiterMsg)

	// 检测 HR 是否索要简历/附件简历 → 触发 BOSS 自动操作
	var bossOperation string
	if lastRecruiterMsg != "" && isResumeRequestMessage(lastRecruiterMsg) {
		bossOperation = domain.BossOpSendResume
	}

	reply := buildContextualReply(jobAnalysis, resumeVersion, lastRecruiterMsg, cleanMode, isFirstRound, hasHrAskedQuestion, recruiterCount, candidateCount)

	reasons := []string{
		"回复基于岗位关键词和已生成简历内容",
		"不自动承诺未确认经历，避免简历和沟通内容不一致",
	}
	if hasHrAskedQuestion {
		reasons = append(reasons, "HR 提出了具体问题，回复正面回答")
	}
	if isFirstRound {
		reasons = append(reasons, "对话刚开始，简要自我介绍并表达沟通意愿")
	}
	if recruiterCount > 2 {
		reasons = append(reasons, fmt.Sprintf("已对话 %d 轮，根据上下文延续自然对话", recruiterCount))
	}
	if bossOperation != "" {
		reasons = append(reasons, "检测到 HR 索要简历，将自动发送简历附件")
	}

	return domain.ChatSuggestion{
		Mode:             cleanMode,
		RecommendedReply: reply,
		AlternativeReplies: []string{
			shortenReply(reply),
			strengthenReply(reply),
		},
		Reasons: reasons,
		NeedUserCheck: []string{
			"确认项目经历是否真实",
			"确认薪资、到岗时间和城市偏好后再发送",
		},
		Generator:     "local_rule",
		BossOperation: bossOperation,
	}
}

// buildContextualReply 根据对话上下文生成不同阶段的回复。
func buildContextualReply(jobAnalysis domain.JobAnalysis, resumeVersion *domain.ResumeVersion, lastRecruiterMsg string, mode string, isFirstRound bool, hasHrAskedQuestion bool, recruiterCount int, candidateCount int) string {
	targetRole := "该岗位"
	if jobAnalysis.Title != "" {
		targetRole = jobAnalysis.Title
	}

	keywords := "岗位要求"
	if len(jobAnalysis.Keywords) > 0 {
		limit := 4
		if len(jobAnalysis.Keywords) < limit {
			limit = len(jobAnalysis.Keywords)
		}
		keywords = strings.Join(jobAnalysis.Keywords[:limit], "、")
	}

	namePrefix := ""
	if resumeVersion != nil && strings.TrimSpace(resumeVersion.Profile.Name) != "" {
		namePrefix = "我是" + resumeVersion.Profile.Name + "，"
	}
	resumePositioning := buildResumePositioning(jobAnalysis, resumeVersion)

	// 第1优先级：HR 提出了具体问题 → 正面回答
	if hasHrAskedQuestion && lastRecruiterMsg != "" {
		return buildQuestionReply(namePrefix, lastRecruiterMsg, keywords, targetRole, mode, resumePositioning)
	}

	// 第2优先级：对话刚开始（第一轮）→ 自我介绍
	if isFirstRound && lastRecruiterMsg == "" {
		return buildOpeningReply(namePrefix, targetRole, keywords, mode, resumePositioning)
	}

	// 第3优先级：HR 发了消息但不是提问 → 根据模式回应
	if lastRecruiterMsg != "" {
		return buildFollowUpReply(namePrefix, lastRecruiterMsg, keywords, targetRole, mode, recruiterCount, resumePositioning)
	}

	// 兜底：无 HR 消息 → 通用开场
	return buildOpeningReply(namePrefix, targetRole, keywords, mode, resumePositioning)
}

// buildQuestionReply 正面回答 HR 的问题。
func buildQuestionReply(namePrefix, question, keywords, targetRole, mode, resumePositioning string) string {
	// 识别问题类型
	questionLower := strings.ToLower(question)

	// 技术/经验类问题
	if strings.Contains(questionLower, "经验") || strings.Contains(questionLower, "项目") || strings.Contains(questionLower, "技术") {
		return namePrefix + "关于您提到的经验方面，" + resumePositioning + "。如果方便，我可以结合简历中的具体内容进一步说明。"
	}

	// 简历/作品类问题
	if strings.Contains(questionLower, "简历") || strings.Contains(questionLower, "作品") || strings.Contains(questionLower, "附件") {
		// 如果是 BOSS 系统索要附件简历，回复确认正在发送
		if strings.Contains(questionLower, "我想要一份您的附件简历") {
			return namePrefix + "好的，我这就通过BOSS直聘发送我的简历附件给您。"
		}
		return namePrefix + "好的，我这就通过BOSS直聘发送我的简历给您，方便您查看。"
	}

	// 到岗/时间类问题
	if strings.Contains(questionLower, "到岗") || strings.Contains(questionLower, "入职") || strings.Contains(questionLower, "时间") {
		return namePrefix + "我目前可以尽快到岗，具体时间可以根据面试进展进一步沟通。"
	}

	// 薪资/期望类问题
	if strings.Contains(questionLower, "薪资") || strings.Contains(questionLower, "期望") || strings.Contains(questionLower, "待遇") {
		return namePrefix + "薪资方面我更看重岗位发展和团队氛围，期望能根据岗位要求和我的匹配度来综合评估。"
	}

	// 通用问题回答
	return namePrefix + "关于您提到的问题，" + resumePositioning + "。如果方便，我可以结合简历中的真实经历进一步说明。"
}

// buildOpeningReply 生成开场白/自我介绍。
func buildOpeningReply(namePrefix, targetRole, keywords, mode, resumePositioning string) string {
	switch mode {
	case "简短直接":
		return namePrefix + "我关注到贵司的" + targetRole + "岗位。" + resumePositioning + "，想进一步了解团队和岗位职责。"
	case "积极主动":
		return namePrefix + "您好，我看了贵司的" + targetRole + "岗位。" + resumePositioning + "。如果岗位还在招聘，希望和您进一步沟通，也可以先发简历供您查看。"
	default:
		return namePrefix + "您好，我关注到贵司的" + targetRole + "岗位。" + resumePositioning + "。希望进一步了解岗位职责和团队情况，也可以先发简历供您查看。"
	}
}

// buildFollowUpReply 生成跟进回复（HR发了消息但不是提问）。
func buildFollowUpReply(namePrefix, hrMsg, keywords, targetRole, mode string, roundCount int, resumePositioning string) string {
	// 如果HR回复很短（如"好的""嗯""可以"），继续推进对话
	if len([]rune(hrMsg)) <= 4 {
		switch mode {
		case "简短直接":
			return "好的，那请问您方便进一步沟通吗？我可以分享更多关于" + keywords + "方向的项目细节。"
		case "积极主动":
			return "好的，我整理了一版针对" + targetRole + "的简历，方便发给您看看吗？"
		default:
			return "好的，那方便进一步沟通吗？我可以分享更多项目细节，也可以先发一版针对该岗位的简历给您。"
		}
	}

	// HR 发了较长的消息，需要承接并推进
	if roundCount >= 3 {
		// 多轮对话后，尝试推进到下一步
		return namePrefix + "感谢您的回复。关于" + targetRole + "这个方向我确实比较感兴趣，方便约个时间进一步沟通吗？"
	}

	// 承接 HR 的消息并表达意愿
	return namePrefix + "了解了，谢谢您的回复。" + resumePositioning + "，期待进一步沟通。"
}

// buildResumePositioning 只使用简历中明确存在的字段和技能，避免固定模板声称不存在的项目经验。
func buildResumePositioning(jobAnalysis domain.JobAnalysis, resumeVersion *domain.ResumeVersion) string {
	if resumeVersion == nil {
		return "我希望进一步确认岗位要求与我的经历是否匹配"
	}

	matchedSkills := matchedResumeSkills(jobAnalysis.Keywords, resumeVersion)
	if len(matchedSkills) > 0 {
		return "JD 提到的" + strings.Join(matchedSkills, "、") + "，我的简历技能中也有对应内容"
	}

	targetRole := utils.CleanText(resumeVersion.Profile.TargetRole, 60)
	location := utils.CleanText(resumeVersion.Profile.Location, 40)
	switch {
	case targetRole != "" && location != "":
		return "我的求职方向是" + targetRole + "，目前在" + location
	case targetRole != "":
		return "我的求职方向是" + targetRole
	case location != "":
		return "我目前在" + location + "，已准备好简历"
	default:
		return "我已准备好真实简历，希望进一步确认双方是否匹配"
	}
}

func matchedResumeSkills(jobKeywords []string, resumeVersion *domain.ResumeVersion) []string {
	resumeSkills := append([]string{}, resumeVersion.Profile.Skills...)
	resumeSkills = append(resumeSkills, extractResumeSkillLines(resumeVersion.Markdown)...)

	matchedSkills := utils.IntersectFold(jobKeywords, utils.UniqueNonEmpty(resumeSkills))
	if len(matchedSkills) > 2 {
		matchedSkills = matchedSkills[:2]
	}
	return matchedSkills
}

func extractResumeSkillLines(markdown string) []string {
	lines := strings.Split(markdown, "\n")
	skills := make([]string, 0)
	inSkillsSection := false
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if strings.HasPrefix(line, "## ") {
			sectionName := strings.TrimSpace(strings.TrimPrefix(line, "## "))
			inSkillsSection = sectionName == "技能栈" || sectionName == "技能标签"
			continue
		}
		if !inSkillsSection || !strings.HasPrefix(line, "- ") {
			continue
		}
		for _, skill := range strings.FieldsFunc(strings.TrimPrefix(line, "- "), func(character rune) bool {
			return character == '、' || character == ',' || character == '，' || character == '/' || character == '／'
		}) {
			cleanSkill := utils.CleanText(skill, 60)
			if cleanSkill != "" && cleanSkill != "待补充" {
				skills = append(skills, cleanSkill)
			}
		}
	}
	return skills
}

func countMessagesByRole(messages []domain.Message) (recruiterCount int, candidateCount int) {
	for _, msg := range messages {
		if strings.EqualFold(msg.Role, "recruiter") {
			recruiterCount++
		} else {
			candidateCount++
		}
	}
	return
}

// detectHrQuestion 检测HR消息是否包含提问。
func detectHrQuestion(text string) bool {
	if text == "" {
		return false
	}
	// 直接问号
	if strings.Contains(text, "?") || strings.Contains(text, "？") {
		return true
	}
	// 常见提问模式
	questionPatterns := []string{
		"方便", "能否", "可以", "能不能", "可不可以",
		"怎么样", "如何", "怎么", "什么", "哪", "谁",
		"吗", "呢", "吧",
		"有没有", "是否有", "有没有过",
		"做过", "用过", "会", "熟悉", "了解",
		"期望", "要求", "考虑", "打算",
	}
	for _, p := range questionPatterns {
		if strings.Contains(text, p) {
			return true
		}
	}
	return false
}

func latestRecruiterQuestion(messages []domain.Message) string {
	for index := len(messages) - 1; index >= 0; index-- {
		message := messages[index]
		if strings.EqualFold(message.Role, "recruiter") && strings.TrimSpace(message.Content) != "" {
			return message.Content
		}
	}
	return ""
}

// isResumeRequestMessage 检测 HR 消息是否索要简历/附件简历
// 匹配模式：
//   - BOSS 系统消息："我想要一份您的附件简历，您是否同意"
//   - 文本消息："方便发一份简历过来吗？""发个简历看看""有没有简历"
func isResumeRequestMessage(text string) bool {
	lower := strings.ToLower(text)

	// BOSS 系统消息：索要附件简历
	if strings.Contains(lower, "我想要一份您的附件简历") {
		return true
	}

	// HR 文本消息：索要简历
	resumePatterns := []string{
		"发一份简历", "发个简历", "发下简历", "发送简历",
		"方便发", "能发", "可以发", "能不能发",
		"有简历", "有没有简历",
		"简历过来", "简历看看", "简历看一下",
		"看下简历", "看下你的简历",
		"发附件", "附件简历",
		"给我简历", "给我你的简历",
	}
	for _, pattern := range resumePatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}

	// "简历" + 问号组合（HR 在问简历的事）
	if strings.Contains(lower, "简历") && (strings.Contains(lower, "?") || strings.Contains(lower, "？")) {
		return true
	}

	return false
}

func shortenReply(reply string) string {
	if len([]rune(reply)) <= 80 {
		return reply
	}
	runes := []rune(reply)
	return string(runes[:80]) + "..."
}

func strengthenReply(reply string) string {
	return reply + " 如果岗位还在招聘，我可以今天补充更完整的项目说明。"
}

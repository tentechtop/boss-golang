package chat

import (
	"strings"
	"testing"

	"boss-job-assistant/internal/domain"
)

func TestSuggestOpeningUsesOnlyResumeSkillsMatchingJob(t *testing.T) {
	suggestion := Suggest(
		domain.JobAnalysis{Title: "Go 后端工程师", Keywords: []string{"Go", "MySQL"}},
		&domain.ResumeVersion{Profile: domain.CandidateProfile{
			TargetRole: "Go 后端",
			Skills:     []string{"Go", "Vue"},
		}},
		nil,
		"积极主动",
	)

	for _, expected := range []string{"Go 后端工程师", "Go", "简历技能"} {
		if !strings.Contains(suggestion.RecommendedReply, expected) {
			t.Fatalf("主动开场白缺少岗位或简历事实 %q: %s", expected, suggestion.RecommendedReply)
		}
	}
	for _, unexpected := range []string{"MySQL", "Vue"} {
		if strings.Contains(suggestion.RecommendedReply, unexpected) {
			t.Fatalf("主动开场白不应引用非岗位匹配技能 %q: %s", unexpected, suggestion.RecommendedReply)
		}
	}
}

func TestSuggestOpeningUsesResumeDirectionWhenSkillsAreMissing(t *testing.T) {
	suggestion := Suggest(
		domain.JobAnalysis{Title: "Golang 工程师", Keywords: []string{"Go", "MySQL"}},
		&domain.ResumeVersion{Profile: domain.CandidateProfile{
			TargetRole: "Go 后端",
			Location:   "深圳",
		}},
		nil,
		"积极主动",
	)

	for _, expected := range []string{"Golang 工程师", "求职方向是Go 后端", "目前在深圳"} {
		if !strings.Contains(suggestion.RecommendedReply, expected) {
			t.Fatalf("技能缺失时开场白没有使用可确认的简历字段 %q: %s", expected, suggestion.RecommendedReply)
		}
	}
	for _, unexpected := range []string{"项目经验比较匹配", "MySQL"} {
		if strings.Contains(suggestion.RecommendedReply, unexpected) {
			t.Fatalf("技能缺失时不应推断未经填写的经历 %q: %s", unexpected, suggestion.RecommendedReply)
		}
	}
}

package job

import "testing"

func TestAnalyzeCalculatesMatchScore(t *testing.T) {
	analysis, analyzeErr := Analyze("要求熟悉 Go、MySQL、Redis，有高并发经验优先。", "Go 后端", "测试公司", []string{"Go", "Redis"})
	if analyzeErr != nil {
		t.Fatalf("分析岗位失败: %v", analyzeErr)
	}

	if analysis.MatchScore <= 0 || analysis.MatchScore > 100 {
		t.Fatalf("匹配分数越界: %d", analysis.MatchScore)
	}
	if len(analysis.Keywords) == 0 {
		t.Fatalf("岗位关键词不能为空")
	}
}

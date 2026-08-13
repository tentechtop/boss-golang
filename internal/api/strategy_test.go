package api

import (
	"strings"
	"testing"
	"time"

	"boss-job-assistant/internal/domain"
)

func TestAnalyzeVisibleJobsAppliesDeliveryStrategy(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 70
	deliveryStrategy.IncludeTitleKeywords = []string{"Go"}
	deliveryStrategy.ExcludeCompanyKeywords = []string{"外包"}

	visibleJobs := []domain.VisibleJob{
		{
			ClientID:    "job_1",
			Title:       "golang后端工程师",
			Company:     "正常科技",
			Salary:      "25-35K",
			Description: "负责 Go 微服务 MySQL Redis 高并发系统",
		},
		{
			ClientID:    "job_2",
			Title:       "Java 后端工程师",
			Company:     "正常科技",
			Salary:      "25-35K",
			Description: "负责 Java Spring 系统",
		},
		{
			ClientID:    "job_3",
			Title:       "golang后端工程师",
			Company:     "外包服务",
			Salary:      "25-35K",
			Description: "负责 Go 微服务 MySQL Redis 高并发系统",
		},
	}

	analyses, analyzeErr := analyzeVisibleJobs(visibleJobs, []string{"Go", "MySQL", "Redis", "微服务", "高并发"}, deliveryStrategy)
	if analyzeErr != nil {
		t.Fatalf("分析可见岗位失败: %v", analyzeErr)
	}
	if len(analyses) != 3 {
		t.Fatalf("分析数量错误: %d", len(analyses))
	}
	if !analyses[0].Eligible {
		t.Fatalf("Go 岗位应符合策略: %#v", analyses[0])
	}
	if !analyses[1].HardBlocked {
		t.Fatalf("未命中岗位必须关键词应硬拦截: %#v", analyses[1])
	}
	if !analyses[2].HardBlocked {
		t.Fatalf("命中公司屏蔽词应硬拦截: %#v", analyses[2])
	}
}

func TestAnalyzeVisibleJobsBlocksHunterCompany(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1

	visibleJobs := []domain.VisibleJob{
		{
			ClientID:    "job_hunter",
			Title:       "golang后端工程师",
			Company:     "华南人力资源服务有限公司",
			Salary:      "25-35K",
			Description: "负责 Go MySQL Redis 微服务高并发系统建设",
		},
	}

	analyses, analyzeErr := analyzeVisibleJobs(visibleJobs, []string{"Go", "MySQL", "Redis"}, deliveryStrategy)
	if analyzeErr != nil {
		t.Fatalf("分析可见岗位失败: %v", analyzeErr)
	}
	if len(analyses) != 1 {
		t.Fatalf("分析数量错误: %d", len(analyses))
	}
	if analyses[0].Eligible {
		t.Fatalf("猎头或人力资源公司不应进入推荐: %#v", analyses[0])
	}
	if !analyses[0].HardBlocked {
		t.Fatalf("猎头或人力资源公司应被硬拦截: %#v", analyses[0])
	}
	if !containsReason(analyses[0].FilterReasons, "人力资源") {
		t.Fatalf("过滤原因应包含命中的猎头公司关键词: %#v", analyses[0].FilterReasons)
	}
}

func TestNormalizeDeliveryStrategyAppendsHunterBlockKeywords(t *testing.T) {
	inputStrategy := domain.DefaultDeliveryStrategy()
	inputStrategy.MinSalaryK = 20
	inputStrategy.MaxSalaryK = 35
	deliveryStrategy := normalizeDeliveryStrategy(inputStrategy)

	if !containsKeyword(deliveryStrategy.ExcludeTitleKeywords, "猎头") {
		t.Fatalf("岗位屏蔽词应自动包含猎头: %#v", deliveryStrategy.ExcludeTitleKeywords)
	}
	if !containsKeyword(deliveryStrategy.ExcludeCompanyKeywords, "人力资源") {
		t.Fatalf("公司屏蔽词应自动包含人力资源: %#v", deliveryStrategy.ExcludeCompanyKeywords)
	}
	if !containsKeyword(deliveryStrategy.ExcludeDescriptionKeywords, "代客户招聘") {
		t.Fatalf("岗位内容屏蔽词应自动包含代客户招聘: %#v", deliveryStrategy.ExcludeDescriptionKeywords)
	}
	if deliveryStrategy.MinSalaryK != 20 || deliveryStrategy.MaxSalaryK != 35 || deliveryStrategy.AllowUnknownSalary {
		t.Fatalf("薪资范围应保留用户当前设置，且未知薪资不应进入投递: %#v", deliveryStrategy)
	}
	if !containsKeyword(deliveryStrategy.IncludeTitleKeywords, defaultTargetRole) || !containsKeyword(deliveryStrategy.IncludeTitleKeywords, "Go后端") {
		t.Fatalf("岗位关键词应覆盖 golang 和 Go 后端常见写法: %#v", deliveryStrategy.IncludeTitleKeywords)
	}
}

func TestNormalizeDeliveryStrategyKeepsCustomTargetRole(t *testing.T) {
	deliveryStrategy := normalizeDeliveryStrategy(domain.DeliveryStrategy{
		IncludeTitleKeywords: []string{"区块链"},
	})

	if len(deliveryStrategy.IncludeTitleKeywords) != 1 || deliveryStrategy.IncludeTitleKeywords[0] != "区块链" {
		t.Fatalf("自定义目标岗位不应被 Go 后端默认值覆盖: %#v", deliveryStrategy.IncludeTitleKeywords)
	}
}

func TestEvaluateDeliveryStrategyTreatsLowScoreAsSoftFilter(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 90

	visibleJob := domain.VisibleJob{
		Title:       "Go 后端工程师",
		Company:     "正常科技",
		Salary:      "25-35K",
		Description: "负责 Go 服务",
	}
	jobAnalysis := domain.JobAnalysis{
		MatchScore: 70,
	}

	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, jobAnalysis, deliveryStrategy)
	if eligible {
		t.Fatalf("低于阈值不应直接合格")
	}
	if hardBlocked {
		t.Fatalf("低于阈值不应硬拦截")
	}
	if len(reasons) == 0 {
		t.Fatalf("低于阈值应返回过滤原因")
	}
}

func TestEvaluateDeliveryStrategyAllowsRelatedBackendTitle(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.MinSalaryK = 25
	deliveryStrategy.MaxSalaryK = 35
	deliveryStrategy.IncludeTitleKeywords = []string{"Go", "Golang"}

	visibleJob := domain.VisibleJob{Title: "后端开发工程师", Salary: "31-51K"}
	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, domain.JobAnalysis{MatchScore: 60}, deliveryStrategy)
	if !eligible || hardBlocked {
		t.Fatalf("大致匹配的后端岗位应允许投递: eligible=%v hardBlocked=%v reasons=%#v", eligible, hardBlocked, reasons)
	}
}

func TestEvaluateDeliveryStrategyStillBlocksUnrelatedTitle(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.IncludeTitleKeywords = []string{"Go", "Golang"}

	visibleJob := domain.VisibleJob{Title: "产品经理"}
	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, domain.JobAnalysis{MatchScore: 60}, deliveryStrategy)
	if eligible || !hardBlocked {
		t.Fatalf("无关岗位仍应被过滤: eligible=%v hardBlocked=%v reasons=%#v", eligible, hardBlocked, reasons)
	}
}

func TestEvaluateDeliveryStrategyRequiresCustomTargetKeyword(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.MinSalaryK = 0
	deliveryStrategy.MaxSalaryK = 0
	deliveryStrategy.IncludeTitleKeywords = []string{"区块链"}

	blockchainJob := domain.VisibleJob{Title: "区块链后端开发工程师", Salary: "25-35K"}
	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(blockchainJob, domain.JobAnalysis{MatchScore: 60}, deliveryStrategy)
	if !eligible || hardBlocked {
		t.Fatalf("命中自定义目标岗位的职位应允许投递: eligible=%v hardBlocked=%v reasons=%#v", eligible, hardBlocked, reasons)
	}

	genericBackendJob := domain.VisibleJob{Title: "后端开发工程师", Salary: "25-35K"}
	eligible, hardBlocked, reasons = evaluateDeliveryStrategy(genericBackendJob, domain.JobAnalysis{MatchScore: 60}, deliveryStrategy)
	if eligible || !hardBlocked {
		t.Fatalf("未命中区块链关键词的普通后端职位应被过滤: eligible=%v hardBlocked=%v reasons=%#v", eligible, hardBlocked, reasons)
	}
}

func TestEvaluateDeliveryStrategyFiltersSalaryRange(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.MinSalaryK = 25
	deliveryStrategy.MaxSalaryK = 35

	testCases := []struct {
		name           string
		salary         string
		expectedReason string
		expectedBlock  bool
	}{
		{name: "below_minimum", salary: "12-18K", expectedReason: "薪资整体低于目标范围", expectedBlock: true},
		{name: "lower_bound_overlaps", salary: "18-25K", expectedBlock: false},
		{name: "inside_range", salary: "25-35K", expectedBlock: false},
		{name: "private_font_inside", salary: "\uE032\uE035-\uE033\uE035K", expectedBlock: false},
		{name: "private_font_overlaps", salary: "\uE032\uE030-\uE033\uE030K", expectedBlock: false},
		{name: "upper_bound_overlaps", salary: "25-40K", expectedBlock: false},
		{name: "similar_above_maximum", salary: "40-60K", expectedBlock: false},
		{name: "private_font_similar_above_maximum", salary: "\uE034\uE031-\uE035\uE036K", expectedBlock: false},
		{name: "far_above_maximum", salary: "46-76K", expectedReason: "薪资明显高于目标范围", expectedBlock: true},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			visibleJob := domain.VisibleJob{
				Title:  "Go 后端工程师",
				Salary: testCase.salary,
			}
			jobAnalysis := domain.JobAnalysis{MatchScore: 80}
			eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, jobAnalysis, deliveryStrategy)

			if hardBlocked != testCase.expectedBlock {
				t.Fatalf("薪资硬拦截状态错误: salary=%s hardBlocked=%v reasons=%#v", testCase.salary, hardBlocked, reasons)
			}
			if testCase.expectedBlock && eligible {
				t.Fatalf("被薪资硬拦截后不应合格: salary=%s", testCase.salary)
			}
			if testCase.expectedReason != "" && !containsReason(reasons, testCase.expectedReason) {
				t.Fatalf("薪资过滤原因缺失: expected=%s reasons=%#v", testCase.expectedReason, reasons)
			}
		})
	}
}

func TestEvaluateDeliveryStrategyAllowsAnyHigherSalaryWithoutMaximum(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.MinSalaryK = 25
	deliveryStrategy.MaxSalaryK = 0
	deliveryStrategy.IncludeTitleKeywords = []string{"区块链"}

	visibleJob := domain.VisibleJob{
		Title:  "区块链钱包与托管系统技术专家",
		Salary: "40-65K·14薪",
	}
	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, domain.JobAnalysis{MatchScore: 80}, deliveryStrategy)
	if !eligible || hardBlocked {
		t.Fatalf("未填写最高月薪时，薪资不低于最低月薪的岗位应允许投递: eligible=%v hardBlocked=%v reasons=%#v", eligible, hardBlocked, reasons)
	}
}

func TestEvaluateDeliveryStrategyBlocksUnknownSalaryWhenConfigured(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 1
	deliveryStrategy.MinSalaryK = 20
	deliveryStrategy.AllowUnknownSalary = false

	visibleJob := domain.VisibleJob{
		Title:  "Go 后端工程师",
		Salary: "面议",
	}
	jobAnalysis := domain.JobAnalysis{MatchScore: 80}
	eligible, hardBlocked, reasons := evaluateDeliveryStrategy(visibleJob, jobAnalysis, deliveryStrategy)

	if eligible {
		t.Fatalf("未知薪资被禁用时不应合格")
	}
	if !hardBlocked {
		t.Fatalf("未知薪资被禁用时应硬拦截")
	}
	if !containsReason(reasons, "薪资未知") {
		t.Fatalf("未知薪资过滤原因缺失: %#v", reasons)
	}
}

func TestDefaultDeliveryStrategyRejectsUnknownSalary(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	if deliveryStrategy.AllowUnknownSalary {
		t.Fatalf("固定薪资模式不应接受未知薪资")
	}

	normalizedStrategy := normalizeDeliveryStrategy(domain.DeliveryStrategy{AllowUnknownSalary: true})
	if normalizedStrategy.AllowUnknownSalary {
		t.Fatalf("归一化后不应重新允许未知薪资")
	}
	if normalizedStrategy.MinSalaryK != fixedMinSalaryK || normalizedStrategy.MaxSalaryK != 0 {
		t.Fatalf("默认最低薪资策略错误: min=%d max=%d", normalizedStrategy.MinSalaryK, normalizedStrategy.MaxSalaryK)
	}
}

func TestNormalizeDeliveryStrategyPreservesBlankMaximumSalary(t *testing.T) {
	deliveryStrategy := normalizeDeliveryStrategy(domain.DeliveryStrategy{
		MinSalaryK: 25,
		MaxSalaryK: 0,
	})
	if deliveryStrategy.MinSalaryK != 25 || deliveryStrategy.MaxSalaryK != 0 {
		t.Fatalf("最高月薪留空时应只保留最低薪资: %#v", deliveryStrategy)
	}
}

func TestParseSalaryRangeK(t *testing.T) {
	testCases := []struct {
		name     string
		salary   string
		minK     int
		maxK     int
		expected bool
	}{
		{name: "k_range", salary: "20-40K·14薪", minK: 20, maxK: 40, expected: true},
		{name: "wan_range", salary: "1.5-2万", minK: 15, maxK: 20, expected: true},
		{name: "single_k", salary: "18K", minK: 18, maxK: 18, expected: true},
		{name: "boss_private_font_range", salary: "\uE032\uE035-\uE033\uE035K", minK: 25, maxK: 35, expected: true},
		{name: "unknown", salary: "面议", expected: false},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			salaryRange := parseSalaryRangeK(testCase.salary)
			if salaryRange.Known != testCase.expected {
				t.Fatalf("薪资识别状态错误: salary=%s range=%#v", testCase.salary, salaryRange)
			}
			if !testCase.expected {
				return
			}
			if salaryRange.MinK != testCase.minK || salaryRange.MaxK != testCase.maxK {
				t.Fatalf("薪资区间错误: salary=%s range=%#v", testCase.salary, salaryRange)
			}
		})
	}
}

func containsKeyword(keywords []string, expectedKeyword string) bool {
	for _, keyword := range keywords {
		if keyword == expectedKeyword {
			return true
		}
	}
	return false
}

func containsReason(reasons []string, expectedText string) bool {
	for _, reason := range reasons {
		if strings.Contains(reason, expectedText) {
			return true
		}
	}
	return false
}

func TestAnalyzeVisibleJobsKeepsVisibleJobMetadata(t *testing.T) {
	deliveryStrategy := domain.DefaultDeliveryStrategy()
	visibleJobs := []domain.VisibleJob{
		{
			ClientID:    "job_1",
			Title:       "Go 后端工程师",
			Company:     "测试公司",
			Location:    "深圳",
			Salary:      "20-30K",
			URL:         "https://example.com/job/1",
			Description: "负责 Go MySQL Redis 微服务 高并发系统",
		},
	}

	analyses, analyzeErr := analyzeVisibleJobs(visibleJobs, []string{"Go", "MySQL", "Redis", "微服务", "高并发"}, deliveryStrategy)
	if analyzeErr != nil {
		t.Fatalf("分析可见岗位失败: %v", analyzeErr)
	}

	jobAnalysis := analyses[0].Analysis
	if jobAnalysis.URL != "https://example.com/job/1" {
		t.Fatalf("岗位 URL 未保留: %s", jobAnalysis.URL)
	}
	if jobAnalysis.Location != "深圳" || jobAnalysis.Salary != "20-30K" {
		t.Fatalf("岗位元数据未保留: location=%s salary=%s", jobAnalysis.Location, jobAnalysis.Salary)
	}
}

func TestFillTaskMatchesNormalizedURL(t *testing.T) {
	jobURL := "https://www.zhipin.com/web/geek/job_detail?query=java&city=101280600"
	currentURL := "https://www.zhipin.com/web/geek/job_detail?query=go&city=101280600#chat"
	if !fillTaskMatchesURL(jobURL, currentURL) {
		t.Fatalf("相同岗位详情路径应匹配")
	}
}

func TestFindFillTaskFallsBackWhenOnlyOneTask(t *testing.T) {
	now := time.Now()
	server := &Server{
		fillTasks: map[string]deliveryFillTask{
			"queue_1": {
				QueueItemID: "queue_1",
				JobURL:      "https://www.zhipin.com/web/geek/job_detail?query=java",
				Draft:       "你好，我对这个岗位感兴趣。",
				CreatedAt:   now,
				ExpiresAt:   now.Add(time.Minute),
			},
		},
	}

	fillTask, exists := server.findFillTask("", "https://www.zhipin.com/web/geek/chat", now)
	if !exists {
		t.Fatalf("单个待填任务应允许在 BOSS 沟通页回退匹配")
	}
	if fillTask.QueueItemID != "queue_1" {
		t.Fatalf("回退任务错误: %s", fillTask.QueueItemID)
	}
}

func TestFindFillTaskUsesQueueItemID(t *testing.T) {
	now := time.Now()
	server := &Server{
		fillTasks: map[string]deliveryFillTask{
			"queue_1": {
				QueueItemID: "queue_1",
				JobURL:      "https://www.zhipin.com/web/geek/job_detail?query=java",
				Draft:       "你好，我对这个岗位感兴趣。",
				CreatedAt:   now,
				ExpiresAt:   now.Add(time.Minute),
			},
			"queue_2": {
				QueueItemID: "queue_2",
				JobURL:      "https://www.zhipin.com/web/geek/job_detail?query=go",
				Draft:       "你好，我有 Go 项目经验。",
				CreatedAt:   now,
				ExpiresAt:   now.Add(time.Minute),
			},
		},
	}

	fillTask, exists := server.findFillTask("queue_2", "https://www.zhipin.com/web/geek/chat", now)
	if !exists {
		t.Fatalf("指定队列 ID 应命中待填任务")
	}
	if fillTask.QueueItemID != "queue_2" {
		t.Fatalf("指定队列 ID 返回错误任务: %s", fillTask.QueueItemID)
	}
}

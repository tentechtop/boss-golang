package database

import (
	"path/filepath"
	"testing"

	"boss-job-assistant/internal/domain"
)

func TestStorePersistsProjects(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	saveErr := store.SaveProjects([]domain.ProjectSummary{{ID: "project_1", Name: "demo", Path: "C:/demo"}})
	if saveErr != nil {
		t.Fatalf("保存项目失败: %v", saveErr)
	}

	reopenedStore, reopenErr := Open(filePath)
	if reopenErr != nil {
		t.Fatalf("重新打开存储失败: %v", reopenErr)
	}
	t.Cleanup(func() {
		if closeErr := reopenedStore.Close(); closeErr != nil {
			t.Fatalf("关闭重新打开的存储失败: %v", closeErr)
		}
	})

	projects := reopenedStore.ListProjects()
	if len(projects) != 1 {
		t.Fatalf("项目数量错误: %d", len(projects))
	}
}

func TestStorePersistsQueueItems(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	saveErr := store.SaveQueueItems([]domain.DeliveryQueueItem{{ID: "queue_1", JobID: "job_1", Title: "Go 后端", Company: "测试公司", URL: "https://example.com/job/1"}})
	if saveErr != nil {
		t.Fatalf("保存队列失败: %v", saveErr)
	}

	reopenedStore, reopenErr := Open(filePath)
	if reopenErr != nil {
		t.Fatalf("重新打开存储失败: %v", reopenErr)
	}
	t.Cleanup(func() {
		if closeErr := reopenedStore.Close(); closeErr != nil {
			t.Fatalf("关闭重新打开的存储失败: %v", closeErr)
		}
	})

	queueItems := reopenedStore.ListQueueItems()
	if len(queueItems) != 1 {
		t.Fatalf("队列数量错误: %d", len(queueItems))
	}
}

func TestStoreUpsertsJobsByURL(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	firstJob := domain.JobAnalysis{
		ID:      "job_1",
		Title:   "Go 后端",
		Company: "测试公司",
		URL:     "https://example.com/job/1",
	}
	if saveErr := store.SaveJob(firstJob); saveErr != nil {
		t.Fatalf("保存首个岗位失败: %v", saveErr)
	}

	secondJob := domain.JobAnalysis{
		ID:         "job_2",
		Title:      "Go 后端高级工程师",
		Company:    "测试公司",
		URL:        "https://example.com/job/1",
		MatchScore: 88,
	}
	savedJobs, saveErr := store.SaveJobsAndReturn([]domain.JobAnalysis{secondJob})
	if saveErr != nil {
		t.Fatalf("保存重复岗位失败: %v", saveErr)
	}

	jobs := store.ListJobs()
	if len(jobs) != 1 {
		t.Fatalf("重复 URL 不应新增岗位: %d", len(jobs))
	}
	if jobs[0].ID != "job_1" || savedJobs[0].ID != "job_1" {
		t.Fatalf("重复岗位应沿用原 ID: stored=%s returned=%s", jobs[0].ID, savedJobs[0].ID)
	}
	if jobs[0].MatchScore != 88 {
		t.Fatalf("重复岗位应更新分析结果: %d", jobs[0].MatchScore)
	}
}

func TestStoreUpsertsManualJobsByContent(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	firstJob := domain.JobAnalysis{ID: "job_1", Title: "Java 后端", Company: "测试公司", Description: "负责 Java 系统"}
	secondJob := domain.JobAnalysis{ID: "job_2", Title: "Java 后端", Company: "测试公司", Description: "负责 Java 系统", MatchScore: 90}
	if saveErr := store.SaveJob(firstJob); saveErr != nil {
		t.Fatalf("保存首个岗位失败: %v", saveErr)
	}
	if _, saveErr := store.SaveJobsAndReturn([]domain.JobAnalysis{secondJob}); saveErr != nil {
		t.Fatalf("保存重复手工岗位失败: %v", saveErr)
	}

	jobs := store.ListJobs()
	if len(jobs) != 1 {
		t.Fatalf("重复手工岗位不应新增: %d", len(jobs))
	}
}

func TestStoreKeepsQueueProgressWhenUpsertSameJob(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	firstItem := domain.DeliveryQueueItem{
		ID:           "queue_1",
		JobID:        "job_1",
		Title:        "Go 后端",
		Company:      "测试公司",
		URL:          "https://example.com/job/1",
		Status:       "delivered",
		OpeningDraft: "您好",
	}
	if saveErr := store.SaveQueueItems([]domain.DeliveryQueueItem{firstItem}); saveErr != nil {
		t.Fatalf("保存首个队列失败: %v", saveErr)
	}

	secondItem := domain.DeliveryQueueItem{
		ID:      "queue_2",
		JobID:   "job_2",
		Title:   "Go 后端",
		Company: "测试公司",
		URL:     "https://example.com/job/1",
		Status:  "queued",
	}
	if saveErr := store.SaveQueueItems([]domain.DeliveryQueueItem{secondItem}); saveErr != nil {
		t.Fatalf("保存重复队列失败: %v", saveErr)
	}

	queueItems := store.ListQueueItems()
	if len(queueItems) != 1 {
		t.Fatalf("重复岗位不应新增队列项: %d", len(queueItems))
	}
	if queueItems[0].Status != "delivered" {
		t.Fatalf("已投递状态不能被回退: %s", queueItems[0].Status)
	}
	if queueItems[0].OpeningDraft == "" {
		t.Fatalf("已有草稿不能被清空")
	}
}

func TestStorePersistsDeliveryStrategy(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	deliveryStrategy := domain.DefaultDeliveryStrategy()
	deliveryStrategy.MinMatchScore = 82
	deliveryStrategy.ExcludeCompanyKeywords = []string{"外包"}
	if saveErr := store.SaveDeliveryStrategy(deliveryStrategy); saveErr != nil {
		t.Fatalf("保存策略失败: %v", saveErr)
	}

	reopenedStore, reopenErr := Open(filePath)
	if reopenErr != nil {
		t.Fatalf("重新打开存储失败: %v", reopenErr)
	}
	t.Cleanup(func() {
		if closeErr := reopenedStore.Close(); closeErr != nil {
			t.Fatalf("关闭重新打开的存储失败: %v", closeErr)
		}
	})

	reloadedStrategy := reopenedStore.GetDeliveryStrategy()
	if reloadedStrategy.MinMatchScore != 82 {
		t.Fatalf("策略最低分未持久化: %d", reloadedStrategy.MinMatchScore)
	}
	if len(reloadedStrategy.ExcludeCompanyKeywords) != 1 {
		t.Fatalf("策略关键词未持久化: %v", reloadedStrategy.ExcludeCompanyKeywords)
	}
}

func TestStoreUsesDefaultDeliveryStrategy(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	deliveryStrategy := store.GetDeliveryStrategy()
	if deliveryStrategy.MinMatchScore != domain.DefaultDeliveryStrategy().MinMatchScore {
		t.Fatalf("默认最低分错误: %d", deliveryStrategy.MinMatchScore)
	}
}

func TestStorePersistsAIReplySettings(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "app-data.json")
	store, openErr := Open(filePath)
	if openErr != nil {
		t.Fatalf("打开存储失败: %v", openErr)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Fatalf("关闭存储失败: %v", closeErr)
		}
	})

	settings := domain.AIReplySettings{
		Provider:       "zhipu",
		FallbackMode:   "deepseek",
		DeepSeekModel:  "deepseek-v4-pro",
		DeepSeekAPIKey: "sk-persistence-test",
		ZhipuModel:     "glm-4.7-flash",
		ZhipuAPIKey:    "zhipu-persistence-test",
	}
	if saveErr := store.SaveAIReplySettings(settings); saveErr != nil {
		t.Fatalf("保存 AI 回复设置失败: %v", saveErr)
	}

	reopenedStore, reopenErr := Open(filePath)
	if reopenErr != nil {
		t.Fatalf("重新打开存储失败: %v", reopenErr)
	}
	t.Cleanup(func() {
		if closeErr := reopenedStore.Close(); closeErr != nil {
			t.Fatalf("关闭重新打开的存储失败: %v", closeErr)
		}
	})

	reloaded := reopenedStore.GetAIReplySettings()
	if reloaded.Provider != settings.Provider || reloaded.FallbackMode != settings.FallbackMode || reloaded.DeepSeekModel != settings.DeepSeekModel || reloaded.DeepSeekAPIKey != settings.DeepSeekAPIKey || reloaded.ZhipuModel != settings.ZhipuModel || reloaded.ZhipuAPIKey != settings.ZhipuAPIKey {
		t.Fatalf("AI 回复设置未持久化: %#v", reloaded)
	}
}

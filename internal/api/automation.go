package api

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"boss-job-assistant/internal/domain"
	"boss-job-assistant/internal/utils"
)

const (
	defaultAutomationScanIntervalMinutes = 1
	defaultAutomationMaxChatRounds       = 10
	defaultAutomationMaxJobsPerScan      = 500
	defaultAutomationMinMatchScore       = fixedMinMatchScore
	defaultAutomationChatMode            = "积极主动"
	automationStatusTTL                  = 90 * time.Second
	browserLaunchThrottle                = 15 * time.Second
)

type saveAutomationControlRequest struct {
	Enabled             bool   `json:"enabled"`
	ResumeID            string `json:"resumeId"`
	Keyword             string `json:"keyword"`
	City                string `json:"city"`
	ChatMode            string `json:"chatMode"`
	ScanIntervalMinutes int    `json:"scanIntervalMinutes"`
	MaxChatRounds       int    `json:"maxChatRounds"`
	MaxJobsPerScan      int    `json:"maxJobsPerScan"`
	MinMatchScore       int    `json:"minMatchScore"`
	LaunchBrowser       bool   `json:"launchBrowser"`
}

type saveAutomationStatusRequest struct {
	BridgeConnected    bool     `json:"bridgeConnected"`
	ExtensionVersion   string   `json:"extensionVersion"`
	RuntimeID          string   `json:"runtimeId"`
	Surface            string   `json:"surface"`
	DesiredRevision    int64    `json:"desiredRevision"`
	AppliedRevision    int64    `json:"appliedRevision"`
	Enabled            bool     `json:"enabled"`
	Phase              string   `json:"phase"`
	CurrentQueueItemID string   `json:"currentQueueItemId"`
	CurrentJobID       string   `json:"currentJobId"`
	TotalProcessed     int      `json:"totalProcessed"`
	TotalChatted       int      `json:"totalChatted"`
	CurrentRound       int      `json:"currentRound"`
	LastScanTime       int64    `json:"lastScanTime"`
	LastChatTime       int64    `json:"lastChatTime"`
	Errors             []string `json:"errors"`
}

func (server *Server) handleGetAutomationControl(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"control": normalizeAutomationControl(server.store.GetAutomationControl()),
	})
}

func (server *Server) handleSaveAutomationControl(responseWriter http.ResponseWriter, request *http.Request) {
	var payload saveAutomationControlRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	automationControl := normalizeAutomationControlPayload(payload, server.store.GetAutomationControl().Revision)
	if saveErr := server.store.SaveAutomationControl(automationControl); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	launchedBrowser := false
	launchErrorText := ""
	if payload.LaunchBrowser {
		if launchErr := server.launchDedicatedBrowser(); launchErr != nil {
			launchErrorText = launchErr.Error()
		} else {
			launchedBrowser = true
		}
	}

	responsePayload := server.buildAutomationStatusResponse()
	responsePayload["control"] = automationControl
	responsePayload["launchedBrowser"] = launchedBrowser
	if launchErrorText != "" {
		responsePayload["launchError"] = launchErrorText
	}

	if server.logger != nil {
		server.logger.Info("自动化控制已更新",
			"enabled", automationControl.Enabled,
			"keyword", automationControl.Keyword,
			"city", automationControl.City,
			"revision", automationControl.Revision,
			"launchBrowser", payload.LaunchBrowser,
			"launchError", launchErrorText,
		)
	}

	writeJSON(responseWriter, http.StatusOK, responsePayload)
}

func (server *Server) handleGetAutomationStatus(responseWriter http.ResponseWriter, request *http.Request) {
	writeJSON(responseWriter, http.StatusOK, server.buildAutomationStatusResponse())
}

func (server *Server) handleSaveAutomationStatus(responseWriter http.ResponseWriter, request *http.Request) {
	var payload saveAutomationStatusRequest
	if decodeErr := server.decodeJSON(request, &payload); decodeErr != nil {
		writeError(responseWriter, http.StatusBadRequest, decodeErr)
		return
	}

	automationStatus := normalizeAutomationStatusPayload(payload)
	if saveErr := server.store.SaveAutomationStatus(automationStatus); saveErr != nil {
		writeError(responseWriter, http.StatusInternalServerError, saveErr)
		return
	}

	writeJSON(responseWriter, http.StatusOK, server.buildAutomationStatusResponse())
}

func (server *Server) buildAutomationStatusResponse() map[string]any {
	automationControl := normalizeAutomationControl(server.store.GetAutomationControl())
	automationStatus := normalizeAutomationStatus(server.store.GetAutomationStatus())
	currentQueueItem := server.findAutomationCurrentQueueItem(automationStatus)
	nextQueueItem := server.findAutomationNextQueueItem()
	if !automationStatus.BridgeConnected && !automationControl.Enabled {
		currentQueueItem = nil
	}

	return map[string]any{
		"control":          automationControl,
		"status":           automationStatus,
		"currentQueueItem": currentQueueItem,
		"nextQueueItem":    nextQueueItem,
	}
}

func (server *Server) findAutomationCurrentQueueItem(automationStatus domain.AutomationStatus) *domain.DeliveryQueueItem {
	queueItems := server.store.ListQueueItems()
	for _, queueItem := range queueItems {
		if automationStatus.CurrentQueueItemID != "" && queueItem.ID == automationStatus.CurrentQueueItemID {
			queueItemCopy := queueItem
			return &queueItemCopy
		}
		if automationStatus.CurrentJobID != "" && queueItem.JobID == automationStatus.CurrentJobID {
			queueItemCopy := queueItem
			return &queueItemCopy
		}
	}
	return nil
}

func (server *Server) findAutomationNextQueueItem() *domain.DeliveryQueueItem {
	queueItems := server.store.ListQueueItems()
	deliveryStrategy := normalizeDeliveryStrategy(server.store.GetDeliveryStrategy())
	var selectedItem *domain.DeliveryQueueItem
	bestPriority := 100

	for _, queueItem := range queueItems {
		if isFinalQueueStatus(queueItem.Status) {
			continue
		}
		if !server.queueItemMatchesDeliveryStrategy(queueItem, deliveryStrategy) {
			continue
		}
		priority := automationQueuePriority(queueItem)
		if priority >= bestPriority {
			continue
		}
		queueItemCopy := queueItem
		selectedItem = &queueItemCopy
		bestPriority = priority
	}
	return selectedItem
}

func automationQueuePriority(queueItem domain.DeliveryQueueItem) int {
	switch queueItem.Status {
	case queueStatusOpened, queueStatusFilled:
		return 1
	case queueStatusPrepared:
		return 2
	case queueStatusQueued, "":
		return 3
	case queueStatusDelivered:
		return 5
	case queueStatusSkipped, queueStatusRejected:
		return 6
	default:
		return 4
	}
}

func normalizeAutomationControlPayload(payload saveAutomationControlRequest, previousRevision int64) domain.AutomationControl {
	now := time.Now()
	return domain.AutomationControl{
		Enabled:             payload.Enabled,
		ResumeID:            utils.CleanText(payload.ResumeID, 120),
		Keyword:             defaultIfEmpty(utils.CleanText(payload.Keyword, 60), defaultTargetRole),
		City:                fixedTargetCity,
		ChatMode:            defaultIfEmpty(utils.CleanText(payload.ChatMode, 20), defaultAutomationChatMode),
		ScanIntervalMinutes: clampInt(payload.ScanIntervalMinutes, defaultAutomationScanIntervalMinutes, 1, 60),
		MaxChatRounds:       clampInt(payload.MaxChatRounds, defaultAutomationMaxChatRounds, 1, 20),
		MaxJobsPerScan:      defaultAutomationMaxJobsPerScan,
		MinMatchScore:       fixedMinMatchScore,
		Revision:            nextAutomationRevision(previousRevision, now),
		UpdatedAt:           now,
	}
}

func normalizeAutomationControl(automationControl domain.AutomationControl) domain.AutomationControl {
	if automationControl.Revision == 0 && automationControl.UpdatedAt.IsZero() {
		automationControl.Enabled = true
	}
	automationControl.ChatMode = defaultIfEmpty(utils.CleanText(automationControl.ChatMode, 20), defaultAutomationChatMode)
	automationControl.ResumeID = utils.CleanText(automationControl.ResumeID, 120)
	automationControl.Keyword = defaultIfEmpty(utils.CleanText(automationControl.Keyword, 60), defaultTargetRole)
	automationControl.City = fixedTargetCity
	automationControl.ScanIntervalMinutes = clampInt(automationControl.ScanIntervalMinutes, defaultAutomationScanIntervalMinutes, 1, 60)
	automationControl.MaxChatRounds = clampInt(automationControl.MaxChatRounds, defaultAutomationMaxChatRounds, 1, 20)
	automationControl.MaxJobsPerScan = defaultAutomationMaxJobsPerScan
	automationControl.MinMatchScore = fixedMinMatchScore
	return automationControl
}

func normalizeAutomationStatusPayload(payload saveAutomationStatusRequest) domain.AutomationStatus {
	return domain.AutomationStatus{
		BridgeConnected:    payload.BridgeConnected,
		ExtensionVersion:   utils.CleanText(payload.ExtensionVersion, 40),
		RuntimeID:          utils.CleanText(payload.RuntimeID, 80),
		Surface:            utils.CleanText(payload.Surface, 40),
		DesiredRevision:    maxInt64(payload.DesiredRevision, 0),
		AppliedRevision:    maxInt64(payload.AppliedRevision, 0),
		Enabled:            payload.Enabled,
		Phase:              sanitizeAutomationPhase(payload.Phase),
		CurrentQueueItemID: utils.CleanText(payload.CurrentQueueItemID, 120),
		CurrentJobID:       utils.CleanText(payload.CurrentJobID, 120),
		TotalProcessed:     clampInt(payload.TotalProcessed, 0, 0, 100000),
		TotalChatted:       clampInt(payload.TotalChatted, 0, 0, 100000),
		CurrentRound:       clampInt(payload.CurrentRound, 0, 0, 50),
		LastScanAt:         timeFromUnixMilliseconds(payload.LastScanTime),
		LastChatAt:         timeFromUnixMilliseconds(payload.LastChatTime),
		LastSeenAt:         time.Now(),
		Errors:             sanitizeAutomationErrors(payload.Errors),
	}
}

func normalizeAutomationStatus(automationStatus domain.AutomationStatus) domain.AutomationStatus {
	automationStatus.ExtensionVersion = utils.CleanText(automationStatus.ExtensionVersion, 40)
	automationStatus.RuntimeID = utils.CleanText(automationStatus.RuntimeID, 80)
	automationStatus.Surface = utils.CleanText(automationStatus.Surface, 40)
	automationStatus.Phase = sanitizeAutomationPhase(automationStatus.Phase)
	automationStatus.CurrentQueueItemID = utils.CleanText(automationStatus.CurrentQueueItemID, 120)
	automationStatus.CurrentJobID = utils.CleanText(automationStatus.CurrentJobID, 120)
	automationStatus.TotalProcessed = clampInt(automationStatus.TotalProcessed, 0, 0, 100000)
	automationStatus.TotalChatted = clampInt(automationStatus.TotalChatted, 0, 0, 100000)
	automationStatus.CurrentRound = clampInt(automationStatus.CurrentRound, 0, 0, 50)
	automationStatus.Errors = sanitizeAutomationErrors(automationStatus.Errors)
	if !isAutomationStatusFresh(automationStatus.LastSeenAt) {
		automationStatus.BridgeConnected = false
	}
	return automationStatus
}

func sanitizeAutomationPhase(phase string) string {
	cleanedPhase := utils.CleanText(phase, 20)
	switch cleanedPhase {
	case "idle", "scanning", "enqueuing", "preparing", "chatting", "opening", "scrolling", "analyzing", "done", "error", "cancelled":
		return cleanedPhase
	default:
		return "idle"
	}
}

func sanitizeAutomationErrors(errors []string) []string {
	if len(errors) == 0 {
		return make([]string, 0)
	}

	cleanedErrors := make([]string, 0, len(errors))
	for _, message := range errors {
		cleanedMessage := utils.CleanText(message, 300)
		if cleanedMessage == "" {
			continue
		}
		cleanedErrors = append(cleanedErrors, cleanedMessage)
		if len(cleanedErrors) >= 5 {
			break
		}
	}
	if cleanedErrors == nil {
		return make([]string, 0)
	}
	return cleanedErrors
}

func timeFromUnixMilliseconds(unixMilliseconds int64) time.Time {
	if unixMilliseconds <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(unixMilliseconds)
}

func isAutomationStatusFresh(lastSeenAt time.Time) bool {
	if lastSeenAt.IsZero() {
		return false
	}
	return time.Since(lastSeenAt) <= automationStatusTTL
}

func nextAutomationRevision(previousRevision int64, now time.Time) int64 {
	revision := now.UnixMilli()
	if revision <= previousRevision {
		return previousRevision + 1
	}
	return revision
}

func clampInt(value int, fallback int, minValue int, maxValue int) int {
	if value == 0 {
		value = fallback
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func defaultIfEmpty(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func maxInt64(value int64, minValue int64) int64 {
	if value < minValue {
		return minValue
	}
	return value
}

func (server *Server) launchDedicatedBrowser() error {
	server.browserLaunchMutex.Lock()
	defer server.browserLaunchMutex.Unlock()

	if time.Since(server.lastBrowserLaunchAt) < browserLaunchThrottle {
		return nil
	}

	if server.browserLaunchFunc == nil {
		return fmt.Errorf("专用 Edge 启动器未配置")
	}

	if launchErr := server.browserLaunchFunc(); launchErr != nil {
		return launchErr
	}
	server.lastBrowserLaunchAt = time.Now()
	return nil
}

func (server *Server) startDedicatedBrowser() error {
	scriptPath, pathErr := resolveStartEdgeScriptPath()
	if pathErr != nil {
		return pathErr
	}

	if _, statErr := os.Stat(scriptPath); statErr != nil {
		return fmt.Errorf("专用 Edge 启动脚本不存在: %w", statErr)
	}

	command := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	command.Dir = filepath.Dir(filepath.Dir(scriptPath))

	if startErr := command.Start(); startErr != nil {
		return fmt.Errorf("启动专用 Edge 失败: %w", startErr)
	}

	go func() {
		if waitErr := command.Wait(); waitErr != nil && server.logger != nil {
			server.logger.Error("专用 Edge 启动脚本执行失败", "error", waitErr)
		}
	}()

	return nil
}

func resolveStartEdgeScriptPath() (string, error) {
	candidates := []string{
		filepath.Join("scripts", "start-edge-with-copilot.ps1"),
	}

	if currentDir, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(currentDir, "scripts", "start-edge-with-copilot.ps1"),
			filepath.Join(currentDir, "..", "scripts", "start-edge-with-copilot.ps1"),
		)
	}

	if executablePath, err := os.Executable(); err == nil {
		execDir := filepath.Dir(executablePath)
		candidates = append(candidates,
			filepath.Join(execDir, "scripts", "start-edge-with-copilot.ps1"),
			filepath.Join(execDir, "..", "scripts", "start-edge-with-copilot.ps1"),
			filepath.Join(execDir, "..", "..", "scripts", "start-edge-with-copilot.ps1"),
		)
	}

	for _, candidate := range candidates {
		normalized, normalizeErr := filepath.Abs(filepath.Clean(candidate))
		if normalizeErr != nil {
			continue
		}
		info, statErr := os.Stat(normalized)
		if statErr == nil && !info.IsDir() {
			return normalized, nil
		}
	}

	return "", fmt.Errorf("无法定位 start-edge-with-copilot.ps1 脚本（请确认 scripts 目录存在）")
}

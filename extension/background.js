const LOCAL_SERVERS = [
  "http://127.0.0.1:8083",
  ...Array.from({ length: 11 }, (_, index) => `http://127.0.0.1:${8080 + index}`).filter((server) => !server.endsWith(":8083"))
];
const SYSTEM_PAGE_URL = "http://127.0.0.1:8083/";
const SYSTEM_PAGE_MATCHERS = ["http://127.0.0.1:8083/*", "http://localhost:8083/*"];
const BOSS_JOBS_URL = "https://www.zhipin.com/web/geek/jobs";
const BOSS_CHAT_URL = "https://www.zhipin.com/web/geek/chat";
const AUTO_MODE_ALARM_NAME = "autoModeScan";
const CODEX_AUTO_REPLY_ALARM_NAME = "codexAutoReplyMonitor";
const AUTOMATION_CONTROL_ALARM_NAME = "automationControlSync";
const AUTO_CHAT_TIMEOUT_MS = 45 * 1000;
const BRIDGE_REQUEST_TTL_MS = 2 * 60 * 1000;
const AUTOMATION_CONTROL_SYNC_DELAY_MS = 2000;
const AUTOMATION_STATUS_SYNC_DELAY_MS = 800;
const AUTOMATION_HEARTBEAT_MINUTES = 0.5;
const TAB_MESSAGE_TIMEOUT_MS = 5000;
const LONG_TAB_MESSAGE_TIMEOUT_MS = 45 * 1000;
const DEFAULT_CHAT_MODE = "积极主动";
const BRIDGE_REQUEST_KEY_PREFIX = "jobCopilotBridgeRequest:";
const BRIDGE_RESULT_KEY_PREFIX = "jobCopilotBridgeResult:";
const LEGACY_SYSTEM_BRIDGE_COMMAND_KEY = "jobCopilotBridgeCommand";
const LEGACY_SYSTEM_BRIDGE_RESULT_KEY = "jobCopilotBridgeResult";
const STORAGE_CLEANUP_MAX_AGE_MS = 5 * 60 * 1000;
const STORAGE_KEEP_BRIDGE_RESULT_COUNT = 10;
const BOSS_CITY_CODE_MAP = Object.freeze({
  "全国": "100010000",
  "北京": "101010100",
  "上海": "101020100",
  "天津": "101030100",
  "重庆": "101040100",
  "广州": "101280100",
  "深圳": "101280600",
  "珠海": "101280700",
  "佛山": "101280800",
  "东莞": "101281600",
  "杭州": "101210100",
  "宁波": "101210400",
  "温州": "101210700",
  "南京": "101190100",
  "苏州": "101190400",
  "无锡": "101190200",
  "常州": "101191100",
  "合肥": "101220100",
  "厦门": "101230200",
  "福州": "101230100",
  "泉州": "101230500",
  "济南": "101120100",
  "青岛": "101120200",
  "武汉": "101200100",
  "长沙": "101250100",
  "郑州": "101180100",
  "西安": "101110100",
  "成都": "101270100",
  "昆明": "101290100",
  "贵阳": "101260100",
  "南宁": "101300100",
  "南昌": "101240100",
  "海口": "101310100",
  "沈阳": "101070100",
  "大连": "101070200",
  "长春": "101060100",
  "哈尔滨": "101050100",
  "石家庄": "101090100",
  "太原": "101100100"
});

importScripts("auto-refill-policy.js", "boss-search-policy.js");

const DEFAULT_CONFIG = {
  scanIntervalMinutes: 1,
  maxChatRounds: 10,
  maxJobsPerScan: 500,
  minMatchScore: 50,
  maxScrollPages: 20,
  scrollDelayMs: 800,
  targetKeyword: "golang后端",
  targetCity: "深圳市"
};

let autoModeState = createDefaultAutoModeState();
let oneClickScanState = createDefaultOneClickScanState();
let batchAutoSendState = createDefaultBatchAutoSendState();
let autoModeCycleRunning = false;
let autoModeCycleTimerId = null;
let bridgeDrainRunning = false;
let automationControlSyncTimerId = null;
let automationStatusSyncTimerId = null;
let automationStatusSyncRunning = false;

chrome.runtime.onInstalled.addListener(() => {
  cleanupLocalStorageQuota().catch(() => {});
  queueAutomationControlSync(0);
});

chrome.runtime.onStartup.addListener(() => {
  cleanupLocalStorageQuota().catch(() => {});
  queueAutomationControlSync(0);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_MODE_ALARM_NAME) {
    queueAutoModeCycle(0);
    return;
  }
  if (alarm.name === CODEX_AUTO_REPLY_ALARM_NAME) {
    ensureCodexAutoReplyMonitor().catch((error) => {
      appendAutoModeError("Codex 自动回复监视器启动失败: " + (error.message || "未知错误"));
    });
    return;
  }
  if (alarm.name === AUTOMATION_CONTROL_ALARM_NAME) {
    queueAutomationControlSync(0);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes) {
    return;
  }

  Object.keys(changes).forEach((storageKey) => {
    const currentChange = changes[storageKey];
    if (!currentChange || !currentChange.newValue) {
      return;
    }

    if (storageKey === LEGACY_SYSTEM_BRIDGE_COMMAND_KEY || storageKey.startsWith(BRIDGE_REQUEST_KEY_PREFIX)) {
      handleBridgeCommand(currentChange.newValue, {
        requestKey: storageKey,
        legacy: storageKey === LEGACY_SYSTEM_BRIDGE_COMMAND_KEY
      }).catch((error) => {
        console.error("[JobCopilot] Bridge command failed:", error.message || error);
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    safeLocalStorageSet({
      jobCopilotLastBackgroundMessage: {
        type: cleanText(message && message.type, 80),
        time: Date.now()
      }
    }).catch(() => {});

    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message" });
      return false;
    }

    if (message.type === "bridgeWakeup") {
      drainPendingBridgeRequests().catch((error) => {
        console.error("[JobCopilot] Bridge drain failed:", error.message || error);
      });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "requestLocalJSON") {
      requestLocalJSON(message.path, message.options || {})
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Local request failed" }));
      return true;
    }

    if (message.type === "openSystemPage") {
      openSystemPage()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Open system page failed" }));
      return true;
    }

    if (message.type === "pullBossJobs") {
      pullBossJobsOnly(message || {})
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Pull jobs failed" }));
      return true;
    }

    if (message.type === "startOneClickScan") {
      startOneClickFullScan(message.config || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "One-click scan failed" }));
      return true;
    }

    if (message.type === "getOneClickScanStatus") {
      sendResponse(buildOneClickScanStatusResponse());
      return false;
    }

    if (message.type === "cancelOneClickScan") {
      cancelOneClickScan();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "getAutoModeStatus") {
      sendResponse({ state: autoModeState });
      return false;
    }

    if (message.type === "setAutoMode") {
      applyAutoModeConfig(message.config || {})
        .then(() => sendResponse({ ok: true, state: autoModeState }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Auto mode update failed" }));
      return true;
    }

    if (message.type === "updateAutoConfig") {
      applyAutoModeConfig(message.config || {})
        .then(() => sendResponse({ ok: true, state: autoModeState }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Auto config update failed" }));
      return true;
    }

    if (message.type === "autoChatCompleted") {
      handleAutoChatCompleted(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Auto chat completion handling failed" }));
      return true;
    }

    if (message.type === "autoSyncCompleted") {
      handleAutoSyncCompleted(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Auto sync completion handling failed" }));
      return true;
    }

    if (message.type === "batchAutoSendAll") {
      executeBatchAutoSendAll(message.config || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "Batch send failed" }));
      return true;
    }

    if (message.type === "getBatchAutoSendStatus") {
      sendResponse({
        running: batchAutoSendState.running,
        totalSent: batchAutoSendState.totalSent,
        totalSkipped: batchAutoSendState.totalSkipped,
        currentIndex: batchAutoSendState.currentIndex,
        totalItems: batchAutoSendState.totalItems,
        currentItem: batchAutoSendState.currentItem
      });
      return false;
    }

    if (message.type === "cancelBatchAutoSend") {
      batchAutoSendState.cancelRequested = true;
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: "Unsupported message type" });
    return false;
  } catch (error) {
    const messageText = error && error.message ? error.message : "Unknown background message error";
    sendResponse({ ok: false, error: "Background message handler failed: " + messageText });
    return false;
  }
});

void initializeBackground();

function createDefaultAutoModeState() {
  return {
    enabled: true,
    phase: "idle",
    currentTabId: null,
    workTabId: null,
    scanTabId: null,
    autoReplyTabId: null,
    currentQueueItemId: "",
    currentJobId: "",
    currentRound: 0,
    totalProcessed: 0,
    totalChatted: 0,
    maxChatRounds: DEFAULT_CONFIG.maxChatRounds,
    scanInterval: DEFAULT_CONFIG.scanIntervalMinutes * 60,
    maxJobsPerScan: DEFAULT_CONFIG.maxJobsPerScan,
    minMatchScore: DEFAULT_CONFIG.minMatchScore,
    resumeId: "",
    keyword: DEFAULT_CONFIG.targetKeyword,
    city: DEFAULT_CONFIG.targetCity,
    chatMode: DEFAULT_CHAT_MODE,
    desiredRevision: 0,
    appliedRevision: 0,
    lastControlSyncAt: 0,
    lastScanTime: 0,
    lastChatTime: 0,
    errors: []
  };
}

function createDefaultOneClickScanState() {
  return {
    running: false,
    cancelRequested: false,
    tabId: null,
    createdTab: false,
    startTime: 0,
    totalJobsFound: 0,
    totalPagesScrolled: 0,
    totalInQueue: 0,
    totalBlocked: 0,
    status: "idle",
    lastError: ""
  };
}

function createDefaultBatchAutoSendState() {
  return {
    running: false,
    cancelRequested: false,
    totalSent: 0,
    totalSkipped: 0,
    currentIndex: 0,
    totalItems: 0,
    currentItem: ""
  };
}

// 功能目的：恢复后台状态；实现原因：浏览器扩展 Service Worker 会被回收，必须从存储恢复自动化配置。
async function initializeBackground() {
  try {
    const storageResult = await chrome.storage.local.get(["autoModeState", "autoModeConfig"]);
    autoModeState = normalizePersistedAutoModeState(storageResult.autoModeState, storageResult.autoModeConfig);
    await saveAutoModeState();
    await drainPendingBridgeRequests();
    scheduleAutomationControlSync();
    await syncAutomationControl().catch((error) => {
      console.warn("[JobCopilot] Initial automation control sync failed:", error.message || error);
    });

    if (autoModeState.enabled) {
      scheduleAutoModeCycle();
      scheduleCodexAutoReplyMonitor();
      // HR 回复监控与找岗位独立运行；聊天页异常不能阻塞扫描和主动联系新岗位。
      void ensureCodexAutoReplyMonitor().catch((error) => {
        console.warn("[JobCopilot] Codex auto reply monitor unavailable:", error.message || error);
      });
      queueAutoModeCycle(300);
      console.log("[JobCopilot] Auto mode restored.");
      return;
    }

    await chrome.alarms.clear(AUTO_MODE_ALARM_NAME);
    console.log("[JobCopilot] Background ready.");
  } catch (error) {
    console.error("[JobCopilot] Failed to initialize background:", error.message || error);
    autoModeState = createDefaultAutoModeState();
  }
}

function normalizePersistedAutoModeState(rawState, rawConfig) {
  const baseState = createDefaultAutoModeState();
  const state = {
    ...baseState,
    ...(rawConfig || {}),
    ...(rawState || {})
  };

  state.enabled = state.enabled === true;
  state.phase = normalizePhase(state.phase);
  state.currentTabId = normalizeTabId(state.currentTabId);
  state.workTabId = normalizeTabId(state.workTabId || state.currentTabId);
  state.scanTabId = normalizeTabId(state.scanTabId);
  state.autoReplyTabId = normalizeTabId(state.autoReplyTabId);
  if (state.autoReplyTabId && state.autoReplyTabId === state.workTabId) {
    state.autoReplyTabId = null;
  }
  if (state.scanTabId && (state.scanTabId === state.workTabId || state.scanTabId === state.autoReplyTabId)) {
    state.scanTabId = null;
  }
  state.currentQueueItemId = cleanText(state.currentQueueItemId, 120);
  state.currentJobId = cleanText(state.currentJobId, 120);
  state.currentRound = normalizeCount(state.currentRound, 0, 0, 50);
  state.totalProcessed = normalizeCount(state.totalProcessed, 0, 0, 100000);
  state.totalChatted = normalizeCount(state.totalChatted, 0, 0, 100000);
  state.maxChatRounds = normalizeCount(state.maxChatRounds, DEFAULT_CONFIG.maxChatRounds, 1, 20);
  state.scanInterval = normalizeCount(
    Math.round(normalizeNumber(state.scanInterval, DEFAULT_CONFIG.scanIntervalMinutes * 60)),
    DEFAULT_CONFIG.scanIntervalMinutes * 60,
    60,
    3600
  );
  state.maxJobsPerScan = normalizeCount(state.maxJobsPerScan, DEFAULT_CONFIG.maxJobsPerScan, 1, 500);
  state.minMatchScore = normalizeCount(state.minMatchScore, DEFAULT_CONFIG.minMatchScore, 1, 100);
  state.resumeId = cleanText(state.resumeId, 120);
  state.keyword = cleanText(state.keyword, 60) || DEFAULT_CONFIG.targetKeyword;
  state.city = cleanText(state.city, 40) || DEFAULT_CONFIG.targetCity;
  state.chatMode = cleanText(state.chatMode, 20) || DEFAULT_CHAT_MODE;
  state.desiredRevision = normalizeCount(state.desiredRevision, 0, 0, Number.MAX_SAFE_INTEGER);
  state.appliedRevision = normalizeCount(state.appliedRevision, 0, 0, Number.MAX_SAFE_INTEGER);
  state.lastControlSyncAt = normalizeCount(state.lastControlSyncAt, 0, 0, Number.MAX_SAFE_INTEGER);
  state.lastScanTime = normalizeCount(state.lastScanTime, 0, 0, Number.MAX_SAFE_INTEGER);
  state.lastChatTime = normalizeCount(state.lastChatTime, 0, 0, Number.MAX_SAFE_INTEGER);
  state.errors = Array.isArray(state.errors) ? state.errors.filter(Boolean).slice(-10) : [];
  return state;
}

function normalizePhase(phase) {
  const allowedPhases = new Set(["idle", "scanning", "enqueuing", "preparing", "chatting", "opening", "scrolling", "analyzing", "done", "error", "cancelled"]);
  const normalized = cleanText(phase, 20);
  if (!allowedPhases.has(normalized)) {
    return "idle";
  }
  return normalized;
}

function normalizeTabId(tabId) {
  const parsedValue = Number(tabId);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }
  return parsedValue;
}

function normalizeNumber(value, fallbackValue) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return fallbackValue;
  }
  return parsedValue;
}

function normalizeCount(value, fallbackValue, minValue, maxValue) {
  const parsedValue = Math.round(normalizeNumber(value, fallbackValue));
  return Math.max(minValue, Math.min(parsedValue, maxValue));
}

function cleanText(value, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, Math.max(0, maxLength || normalized.length));
}

function buildPersistedAutoModeConfig() {
  return {
    scanIntervalMinutes: Math.max(1, Math.round(autoModeState.scanInterval / 60)),
    maxChatRounds: autoModeState.maxChatRounds,
    maxJobsPerScan: autoModeState.maxJobsPerScan,
    minMatchScore: autoModeState.minMatchScore,
    resumeId: autoModeState.resumeId,
    keyword: autoModeState.keyword,
    city: autoModeState.city,
    chatMode: autoModeState.chatMode
  };
}

async function saveAutoModeState() {
  await safeLocalStorageSet({
    autoModeState,
    autoModeConfig: buildPersistedAutoModeConfig()
  });
  queueAutomationStatusSync(AUTOMATION_STATUS_SYNC_DELAY_MS);
}

function scheduleAutomationControlSync() {
  chrome.alarms.clear(AUTOMATION_CONTROL_ALARM_NAME, () => {
    chrome.alarms.create(AUTOMATION_CONTROL_ALARM_NAME, { periodInMinutes: AUTOMATION_HEARTBEAT_MINUTES });
  });
}

function queueAutomationControlSync(delayMs) {
  if (automationControlSyncTimerId) {
    clearTimeout(automationControlSyncTimerId);
    automationControlSyncTimerId = null;
  }

  automationControlSyncTimerId = setTimeout(() => {
    automationControlSyncTimerId = null;
    syncAutomationControl().catch((error) => {
      console.warn("[JobCopilot] Automation control sync failed:", error.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function queueAutomationStatusSync(delayMs) {
  if (automationStatusSyncTimerId) {
    clearTimeout(automationStatusSyncTimerId);
    automationStatusSyncTimerId = null;
  }

  automationStatusSyncTimerId = setTimeout(() => {
    automationStatusSyncTimerId = null;
    syncAutomationStatus().catch((error) => {
      console.warn("[JobCopilot] Automation status sync failed:", error.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function buildAutomationStatusPayload() {
  return {
    bridgeConnected: true,
    extensionVersion: chrome.runtime.getManifest().version,
    runtimeId: chrome.runtime.id,
    surface: "edge-extension",
    desiredRevision: normalizeCount(autoModeState.desiredRevision, 0, 0, Number.MAX_SAFE_INTEGER),
    appliedRevision: normalizeCount(autoModeState.appliedRevision, 0, 0, Number.MAX_SAFE_INTEGER),
    enabled: autoModeState.enabled === true,
    phase: normalizePhase(autoModeState.phase),
    currentQueueItemId: cleanText(autoModeState.currentQueueItemId, 120),
    currentJobId: cleanText(autoModeState.currentJobId, 120),
    totalProcessed: normalizeCount(autoModeState.totalProcessed, 0, 0, 100000),
    totalChatted: normalizeCount(autoModeState.totalChatted, 0, 0, 100000),
    currentRound: normalizeCount(autoModeState.currentRound, 0, 0, 50),
    lastScanTime: normalizeCount(autoModeState.lastScanTime, 0, 0, Number.MAX_SAFE_INTEGER),
    lastChatTime: normalizeCount(autoModeState.lastChatTime, 0, 0, Number.MAX_SAFE_INTEGER),
    errors: Array.isArray(autoModeState.errors) ? autoModeState.errors.slice(-5) : []
  };
}

async function syncAutomationStatus() {
  if (automationStatusSyncRunning) {
    return;
  }
  automationStatusSyncRunning = true;

  try {
    await requestLocalJSON("/api/automation/status", {
      method: "POST",
      body: JSON.stringify(buildAutomationStatusPayload())
    });
  } finally {
    automationStatusSyncRunning = false;
  }
}

async function syncAutomationControl() {
  const payload = await requestLocalJSON("/api/automation/control", { method: "GET" });
  const control = normalizeRemoteAutomationControl(payload && payload.control);
  autoModeState.lastControlSyncAt = Date.now();

  if (!control) {
    await saveAutoModeState();
    return;
  }

  autoModeState.desiredRevision = control.revision;
  await saveAutoModeState();

  const controlAlreadyApplied = control.revision <= autoModeState.appliedRevision &&
    control.enabled === autoModeState.enabled &&
    control.keyword === autoModeState.keyword &&
    control.city === autoModeState.city &&
    control.maxJobsPerScan === autoModeState.maxJobsPerScan &&
    control.minMatchScore === autoModeState.minMatchScore;
  if (controlAlreadyApplied) {
    queueAutomationStatusSync(0);
    return;
  }

  await applyAutoModeConfig({
    enabled: control.enabled,
    resumeId: control.resumeId,
    keyword: control.keyword,
    city: control.city,
    chatMode: control.chatMode,
    scanIntervalMinutes: control.scanIntervalMinutes,
    maxChatRounds: control.maxChatRounds,
    maxJobsPerScan: control.maxJobsPerScan,
    minMatchScore: control.minMatchScore
  });
  autoModeState.appliedRevision = control.revision;
  await saveAutoModeState();
}

function normalizeRemoteAutomationControl(control) {
  if (!control || typeof control !== "object") {
    return null;
  }
  return {
    enabled: control.enabled === true,
    resumeId: cleanText(control.resumeId, 120),
    keyword: cleanText(control.keyword, 60) || DEFAULT_CONFIG.targetKeyword,
    city: cleanText(control.city, 40) || DEFAULT_CONFIG.targetCity,
    chatMode: cleanText(control.chatMode, 20) || DEFAULT_CHAT_MODE,
    scanIntervalMinutes: normalizeCount(control.scanIntervalMinutes, DEFAULT_CONFIG.scanIntervalMinutes, 1, 60),
    maxChatRounds: normalizeCount(control.maxChatRounds, DEFAULT_CONFIG.maxChatRounds, 1, 20),
    maxJobsPerScan: normalizeCount(control.maxJobsPerScan, DEFAULT_CONFIG.maxJobsPerScan, 1, 500),
    minMatchScore: normalizeCount(control.minMatchScore, DEFAULT_CONFIG.minMatchScore, 1, 100),
    revision: normalizeCount(control.revision, 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

async function removeBridgeArtifacts(requestKey, requestPayload, legacy) {
  const removeKeys = [];
  if (requestKey) {
    removeKeys.push(requestKey);
  }
  const requestId = cleanText(requestPayload && requestPayload.requestId, 120);
  if (requestId) {
    removeKeys.push(buildBridgeResultKey(requestId));
  }
  if (legacy) {
    removeKeys.push(LEGACY_SYSTEM_BRIDGE_RESULT_KEY);
  }
  if (removeKeys.length === 0) {
    return;
  }
  await chrome.storage.local.remove(removeKeys);
}

async function drainPendingBridgeRequests() {
  if (bridgeDrainRunning) {
    return;
  }
  bridgeDrainRunning = true;

  try {
    const storagePayload = await chrome.storage.local.get(null);
    const pendingKeys = Object.keys(storagePayload || {}).filter((storageKey) => {
      return storageKey === LEGACY_SYSTEM_BRIDGE_COMMAND_KEY || storageKey.startsWith(BRIDGE_REQUEST_KEY_PREFIX);
    }).sort((leftKey, rightKey) => {
      const leftCommand = storagePayload[leftKey] || {};
      const rightCommand = storagePayload[rightKey] || {};
      return Number(leftCommand.createdAt || 0) - Number(rightCommand.createdAt || 0);
    });

    for (const requestKey of pendingKeys) {
      const requestPayload = storagePayload[requestKey];
      if (!requestPayload) {
        continue;
      }
      const createdAt = Number(requestPayload.createdAt || 0);
      const isExpired = createdAt > 0 && Date.now() - createdAt > BRIDGE_REQUEST_TTL_MS;
      const isLegacy = requestKey === LEGACY_SYSTEM_BRIDGE_COMMAND_KEY;
      if (isExpired) {
        await removeBridgeArtifacts(requestKey, requestPayload, isLegacy);
        continue;
      }
      await handleBridgeCommand(requestPayload, {
        requestKey: requestKey,
        legacy: isLegacy
      });
    }
  } finally {
    bridgeDrainRunning = false;
  }
}

function buildBridgeResultKey(requestId) {
  return BRIDGE_RESULT_KEY_PREFIX + cleanText(requestId, 120);
}

function buildBatchAutoSendStatusPayload() {
  return {
    running: batchAutoSendState.running,
    totalSent: batchAutoSendState.totalSent,
    totalSkipped: batchAutoSendState.totalSkipped,
    currentIndex: batchAutoSendState.currentIndex,
    totalItems: batchAutoSendState.totalItems,
    currentItem: batchAutoSendState.currentItem
  };
}

async function publishBridgeResult(requestId, payload, context) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const result = {
    ...safePayload,
    requestId: cleanText(requestId, 120),
    ok: safePayload.ok === true,
    error: cleanText(safePayload.error, 300),
    updatedAt: Date.now()
  };
  const writePayload = {
    [buildBridgeResultKey(requestId)]: result
  };
  if (context && context.legacy) {
    writePayload[LEGACY_SYSTEM_BRIDGE_RESULT_KEY] = result;
  }
  await safeLocalStorageSet(writePayload);
}

async function safeLocalStorageSet(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, async () => {
      const runtimeError = chrome.runtime.lastError;
      if (!runtimeError) {
        resolve();
        return;
      }
      if (!isStorageQuotaError(runtimeError)) {
        reject(new Error(runtimeError.message || "写入扩展存储失败"));
        return;
      }
      try {
        await cleanupLocalStorageQuota();
        chrome.storage.local.set(payload, () => {
          const retryError = chrome.runtime.lastError;
          if (retryError) {
            reject(new Error(retryError.message || "清理后仍无法写入扩展存储"));
            return;
          }
          resolve();
        });
      } catch (cleanupError) {
        reject(cleanupError);
      }
    });
  });
}

function isStorageQuotaError(error) {
  const message = String((error && error.message) || error || "").toLowerCase();
  return message.includes("quota") || message.includes("kquotabytes");
}

async function cleanupLocalStorageQuota() {
  const storagePayload = await chrome.storage.local.get(null);
  const now = Date.now();
  const removeKeys = [];
  const bridgeResults = [];

  Object.keys(storagePayload || {}).forEach((storageKey) => {
    const value = storagePayload[storageKey];
    if (storageKey === "jobCopilotLastBackgroundMessage") {
      removeKeys.push(storageKey);
      return;
    }
    if (storageKey === LEGACY_SYSTEM_BRIDGE_COMMAND_KEY || storageKey === LEGACY_SYSTEM_BRIDGE_RESULT_KEY) {
      removeKeys.push(storageKey);
      return;
    }
    if (storageKey.startsWith(BRIDGE_REQUEST_KEY_PREFIX)) {
      const createdAt = Number((value && value.createdAt) || 0);
      if (!createdAt || now - createdAt > STORAGE_CLEANUP_MAX_AGE_MS) {
        removeKeys.push(storageKey);
      }
      return;
    }
    if (storageKey.startsWith(BRIDGE_RESULT_KEY_PREFIX)) {
      bridgeResults.push({ key: storageKey, updatedAt: Number((value && value.updatedAt) || 0) });
    }
  });

  bridgeResults
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(STORAGE_KEEP_BRIDGE_RESULT_COUNT)
    .forEach((item) => removeKeys.push(item.key));

  if (removeKeys.length > 0) {
    await chrome.storage.local.remove(Array.from(new Set(removeKeys)));
  }
}

async function executeBridgeCommand(command) {
  const commandType = cleanText(command && command.type, 60);
  switch (commandType) {
    case "setAutoMode":
    case "updateAutoConfig":
      await applyAutoModeConfig(command.config || {});
      return { ok: true, state: autoModeState };
    case "getAutoModeStatus":
      return { ok: true, state: autoModeState };
    case "requestLocalJSON":
      return {
        ok: true,
        payload: await requestLocalJSON(command.path, command.options || {})
      };
    case "openSystemPage":
      await openSystemPage();
      return { ok: true };
    case "pullBossJobs":
      return {
        ok: true,
        payload: await pullBossJobsOnly(command || {})
      };
    case "startOneClickScan":
      return {
        ok: true,
        ...(await startOneClickFullScan(command.config || {}))
      };
    case "getOneClickScanStatus":
      return {
        ok: true,
        ...buildOneClickScanStatusResponse()
      };
    case "cancelOneClickScan":
      cancelOneClickScan();
      return { ok: true };
    case "batchAutoSendAll":
      return {
        ok: true,
        ...(await executeBatchAutoSendAll(command.config || {}))
      };
    case "getBatchAutoSendStatus":
      return {
        ok: true,
        ...buildBatchAutoSendStatusPayload()
      };
    case "cancelBatchAutoSend":
      batchAutoSendState.cancelRequested = true;
      return { ok: true };
    case "autoChatCompleted":
      await handleAutoChatCompleted(command || {});
      return { ok: true, state: autoModeState };
    case "autoSyncCompleted":
      await handleAutoSyncCompleted(command || {});
      return { ok: true, state: autoModeState };
    default:
      throw new Error("Unsupported bridge command");
  }
}

// 功能目的：处理内容脚本发来的存储桥命令；实现原因：关键自动化流程必须绕过当前不稳定的 runtime.sendMessage。
async function handleBridgeCommand(command, context) {
  const requestId = cleanText(command && command.requestId, 120);
  if (!requestId) {
    return;
  }

  try {
    const result = await executeBridgeCommand(command || {});
    await publishBridgeResult(requestId, result, context);
  } catch (error) {
    await publishBridgeResult(requestId, {
      ok: false,
      error: error && error.message ? error.message : "Bridge command failed",
      state: autoModeState
    }, context);
  } finally {
    if (context && context.requestKey) {
      await chrome.storage.local.remove([context.requestKey]).catch(() => {});
    }
  }
}

function disableAutoMode(logMessage) {
  autoModeState.enabled = false;
  autoModeState.phase = "idle";
  autoModeState.currentQueueItemId = "";
  autoModeState.currentJobId = "";
  autoModeState.currentRound = 0;
  autoModeState.currentTabId = null;
  autoModeState.errors = [];
  queueAutoModeCycle(-1);
  saveAutoModeState().catch(() => {});
  chrome.alarms.clear(AUTO_MODE_ALARM_NAME);
  console.log("[JobCopilot] " + logMessage);
}

// 功能目的：应用全自动求职配置；实现原因：无障碍流程需要一次写入简历、筛选条件和聊天策略。
async function applyAutoModeConfig(config) {
  if (Object.prototype.hasOwnProperty.call(config, "scanIntervalMinutes")) {
    autoModeState.scanInterval = normalizeCount(
      Number(config.scanIntervalMinutes) * 60,
      DEFAULT_CONFIG.scanIntervalMinutes * 60,
      60,
      3600
    );
  }
  if (Object.prototype.hasOwnProperty.call(config, "maxChatRounds")) {
    autoModeState.maxChatRounds = normalizeCount(config.maxChatRounds, DEFAULT_CONFIG.maxChatRounds, 1, 20);
  }
  if (Object.prototype.hasOwnProperty.call(config, "maxJobsPerScan")) {
    autoModeState.maxJobsPerScan = normalizeCount(config.maxJobsPerScan, DEFAULT_CONFIG.maxJobsPerScan, 1, 500);
  }
  if (Object.prototype.hasOwnProperty.call(config, "minMatchScore")) {
    autoModeState.minMatchScore = normalizeCount(config.minMatchScore, DEFAULT_CONFIG.minMatchScore, 1, 100);
  }
  if (Object.prototype.hasOwnProperty.call(config, "resumeId")) {
    autoModeState.resumeId = cleanText(config.resumeId, 120);
  }
  if (Object.prototype.hasOwnProperty.call(config, "keyword")) {
    autoModeState.keyword = cleanText(config.keyword, 60) || DEFAULT_CONFIG.targetKeyword;
  }
  if (Object.prototype.hasOwnProperty.call(config, "city")) {
    autoModeState.city = cleanText(config.city, 40) || DEFAULT_CONFIG.targetCity;
  }
  if (Object.prototype.hasOwnProperty.call(config, "chatMode")) {
    autoModeState.chatMode = cleanText(config.chatMode, 20) || DEFAULT_CHAT_MODE;
  }
  if (Object.prototype.hasOwnProperty.call(config, "enabled")) {
    autoModeState.enabled = config.enabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(config, "initialProcessed")) {
    autoModeState.totalProcessed = normalizeCount(config.initialProcessed, autoModeState.totalProcessed, 0, 100000);
  }
  if (Object.prototype.hasOwnProperty.call(config, "initialChatted")) {
    autoModeState.totalChatted = normalizeCount(config.initialChatted, autoModeState.totalChatted, 0, 100000);
  }

  if (!autoModeState.enabled) {
    await stopAutoModeRun();
    await chrome.alarms.clear(AUTO_MODE_ALARM_NAME);
    await chrome.alarms.clear(CODEX_AUTO_REPLY_ALARM_NAME);
    await stopCodexAutoReplyMonitor();
    return;
  }

  autoModeState.phase = "idle";
  autoModeState.errors = [];
  await saveAutoModeState();
  scheduleAutoModeCycle();
  scheduleCodexAutoReplyMonitor();
  // 监控页可能被 BOSS 页面或浏览器节流，异步恢复即可，不能卡住自动求职主循环。
  void ensureCodexAutoReplyMonitor().catch((error) => {
    appendAutoModeError("Codex 自动回复监视器启动失败: " + (error.message || "未知错误"));
  });
  queueAutoModeCycle(300);
}

function scheduleAutoModeCycle() {
  if (!autoModeState.enabled) {
    chrome.alarms.clear(AUTO_MODE_ALARM_NAME);
    return;
  }

  const periodMinutes = Math.max(1, Math.floor(autoModeState.scanInterval / 60));
  chrome.alarms.clear(AUTO_MODE_ALARM_NAME, () => {
    chrome.alarms.create(AUTO_MODE_ALARM_NAME, { periodInMinutes: periodMinutes });
  });
}

// 功能目的：定时唤醒固定的聊天监视页；实现原因：后台标签页计时器会被浏览器降频，不能只依赖页面轮询。
function scheduleCodexAutoReplyMonitor() {
  if (!autoModeState.enabled) {
    chrome.alarms.clear(CODEX_AUTO_REPLY_ALARM_NAME);
    return;
  }
  chrome.alarms.clear(CODEX_AUTO_REPLY_ALARM_NAME, () => {
    chrome.alarms.create(CODEX_AUTO_REPLY_ALARM_NAME, { periodInMinutes: 0.5 });
  });
}

// 功能目的：复用单一后台聊天页处理 HR 未读消息；实现原因：自动投递页会持续跳转，不能承担长期消息监听。
async function ensureCodexAutoReplyMonitor() {
  if (!autoModeState.enabled) {
    return null;
  }

  let monitorTab = null;
  if (autoModeState.autoReplyTabId) {
    try {
      const savedTab = await chrome.tabs.get(autoModeState.autoReplyTabId);
      if (savedTab && savedTab.id && /zhipin\.com/i.test(String(savedTab.url || ""))) {
        monitorTab = savedTab;
      }
    } catch (error) {
      autoModeState.autoReplyTabId = null;
    }
  }

  if (!monitorTab) {
    const chatTabs = await chrome.tabs.query({ url: ["https://www.zhipin.com/web/geek/chat*", "https://*.zhipin.com/web/geek/chat*"] });
    monitorTab = chatTabs.find((tab) => tab && tab.id && tab.id !== autoModeState.workTabId && tab.id !== autoModeState.currentTabId && tab.id !== autoModeState.scanTabId) || null;
  }
  if (!monitorTab) {
    monitorTab = await chrome.tabs.create({ url: BOSS_CHAT_URL, active: false });
  } else if (!String(monitorTab.url || "").includes("/web/geek/chat")) {
    monitorTab = await chrome.tabs.update(monitorTab.id, { url: BOSS_CHAT_URL, active: false });
  }

  autoModeState.autoReplyTabId = monitorTab.id;
  await saveAutoModeState();
  await waitForTabReady(monitorTab.id, 15000);
  await ensureContentScript(monitorTab.id);
  let monitorResponse = await sendTabMessageSafe(monitorTab.id, {
    type: "startCodexAutoReplyMonitor",
    resumeId: autoModeState.resumeId || "",
    mode: autoModeState.chatMode || DEFAULT_CHAT_MODE,
    maxRounds: autoModeState.maxChatRounds
  });
  if (!monitorResponse || monitorResponse.ok !== true) {
    await chrome.tabs.reload(monitorTab.id);
    await waitForTabReady(monitorTab.id, 15000);
    await ensureContentScript(monitorTab.id);
    monitorResponse = await sendTabMessageSafe(monitorTab.id, {
      type: "startCodexAutoReplyMonitor",
      resumeId: autoModeState.resumeId || "",
      mode: autoModeState.chatMode || DEFAULT_CHAT_MODE,
      maxRounds: autoModeState.maxChatRounds
    });
  }
  if (!monitorResponse || monitorResponse.ok !== true) {
    throw new Error("HR 自动回复监视器未能接管聊天页");
  }
  return monitorTab;
}

async function stopCodexAutoReplyMonitor() {
  if (!autoModeState.autoReplyTabId) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(autoModeState.autoReplyTabId, { type: "stopCodexAutoReplyMonitor" });
  } catch (error) {}
}

function queueAutoModeCycle(delayMs) {
  if (autoModeCycleTimerId) {
    clearTimeout(autoModeCycleTimerId);
    autoModeCycleTimerId = null;
  }
  if (delayMs < 0) {
    return;
  }

  autoModeCycleTimerId = setTimeout(() => {
    autoModeCycleTimerId = null;
    executeAutoModeCycle().catch((error) => {
      appendAutoModeError("自动模式执行失败: " + (error.message || "未知错误"));
      console.error("[JobCopilot] Auto mode cycle failed:", error.message || error);
      const retryDelay = JobCopilotAutoRefillPolicy.resolveRetryDelay(autoModeState.enabled, false);
      if (retryDelay >= 0) {
        queueAutoModeCycle(retryDelay);
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function resolvePostChatDelay(status) {
  return JobCopilotAutoRefillPolicy.resolvePostChatDelay(status, Math.random());
}

async function stopAutoModeRun() {
  autoModeState.phase = "idle";
  autoModeState.currentQueueItemId = "";
  autoModeState.currentJobId = "";
  autoModeState.currentRound = 0;
  await stopCurrentAutomationTab();
  await saveAutoModeState();
}

function appendAutoModeError(message) {
  const cleanMessage = cleanText(message, 300);
  if (!cleanMessage) {
    return;
  }
  autoModeState.errors = [...(autoModeState.errors || []), cleanMessage].slice(-10);
  autoModeState.phase = "idle";
  saveAutoModeState().catch(() => {});
}

// 功能目的：驱动持续自动求职状态机；实现原因：自动扫描、自动准备和自动聊天必须串行执行，避免竞态。
async function executeAutoModeCycle() {
  if (!autoModeState.enabled || autoModeCycleRunning) {
    return;
  }

  autoModeCycleRunning = true;
  try {
    await syncAutomationControl().catch(() => {});
    if (!autoModeState.enabled) {
      return;
    }

    if (await recoverTimedOutAutoChat()) {
      if (JobCopilotAutoRefillPolicy.shouldRunConcurrentScan(
        autoModeState.enabled,
        Boolean(autoModeState.currentQueueItemId),
        autoModeState.lastScanTime,
        Date.now()
      )) {
        await openAndScanBossJobs({ enqueueOnly: true });
      }
      return;
    }

    if (autoModeState.currentQueueItemId) {
      return;
    }

    const pendingItem = await getNextAutoQueueItem();
    if (pendingItem && pendingItem.id) {
      await processOneQueueItem(pendingItem);
      return;
    }

    await openAndScanBossJobs();
  } finally {
    autoModeCycleRunning = false;
  }
}

async function recoverTimedOutAutoChat() {
  if (!autoModeState.currentQueueItemId) {
    return false;
  }

  let currentTabAlive = false;
  if (autoModeState.currentTabId) {
    try {
      const currentTab = await chrome.tabs.get(autoModeState.currentTabId);
      currentTabAlive = !!(currentTab && currentTab.id && /zhipin\.com/i.test(String(currentTab.url || "")));
    } catch (error) {
      currentTabAlive = false;
    }
  }

  if (!currentTabAlive) {
    if (autoModeState.workTabId === autoModeState.currentTabId) {
      autoModeState.workTabId = null;
    }
    autoModeState.currentQueueItemId = "";
    autoModeState.currentJobId = "";
    autoModeState.currentRound = 0;
    autoModeState.currentTabId = null;
    autoModeState.phase = "idle";
    autoModeState.lastChatTime = Date.now();
    appendAutoModeError("自动聊天标签页已关闭，已重新调度队列");
    await saveAutoModeState();
    queueAutoModeCycle(resolvePostChatDelay("stopped"));
    return true;
  }

  if (Date.now() - autoModeState.lastChatTime < AUTO_CHAT_TIMEOUT_MS) {
    return true;
  }

  const queueItemId = autoModeState.currentQueueItemId;
  console.warn("[JobCopilot] Auto chat timed out: " + queueItemId);
  await stopCurrentAutomationTab();
  autoModeState.currentQueueItemId = "";
  autoModeState.currentJobId = "";
  autoModeState.currentRound = 0;
  autoModeState.phase = "idle";
  appendAutoModeError("自动聊天等待超时，岗位保留并将在稍后重试: " + queueItemId);
  queueAutoModeCycle(JobCopilotAutoRefillPolicy.resolvePacedDelay(1000, 2000, Math.random()));
  return true;
}

// 功能目的：执行一轮岗位扫描入队；实现原因：持续模式下不应要求用户再次打开 BOSS 页面或再次点击。
async function openAndScanBossJobs(options) {
  const settings = options || {};
  const enqueueOnly = settings.enqueueOnly === true;
  if (!enqueueOnly) {
    autoModeState.phase = "scanning";
  }
  autoModeState.lastScanTime = Date.now();
  await saveAutoModeState();

  let scanTabId = null;
  {
    let scanPayload;
    try {
      scanPayload = await collectBossJobs(
        {
          maxPages: DEFAULT_CONFIG.maxScrollPages,
          scrollDelay: DEFAULT_CONFIG.scrollDelayMs,
          maxJobs: autoModeState.maxJobsPerScan,
          minScore: autoModeState.minMatchScore,
          keyword: autoModeState.keyword,
          city: autoModeState.city
        },
        {
          active: false,
          reuseExisting: true,
          stopAfterFirstNewBatch: true,
          preferredTabId: autoModeState.scanTabId,
          excludeTabIds: [autoModeState.currentTabId, autoModeState.workTabId, autoModeState.autoReplyTabId],
          preserveWorkTab: true
        }
      );
    } catch (error) {
      console.warn("[JobCopilot] BOSS scan failed, trying persisted jobs:", error.message || error);
      const fallbackQueuedCount = await enqueueEligibleCapturedJobsFromLocalStore();
      if (fallbackQueuedCount === 0) {
        throw new Error("岗位扫描失败，本地岗位库也没有可补充岗位: " + (error.message || "未知错误"));
      }
      scanPayload = { tabId: null, jobs: [], analyses: [] };
    }

    scanTabId = scanPayload.tabId;
    autoModeState.scanTabId = scanTabId;
    autoModeState.totalProcessed += scanPayload.jobs.length;
    await saveAutoModeState();

    const eligibleJobs = (scanPayload.analyses || []).filter((item) => item && item.eligible && item.source).map((item) => item.source);
    const queuedCount = await enqueueEligibleJobsForAutoMode(eligibleJobs);
    if (queuedCount === 0) {
      await enqueueEligibleCapturedJobsFromLocalStore();
    }
  }

  if (enqueueOnly) {
    autoModeState.phase = autoModeState.currentQueueItemId ? "chatting" : "idle";
    await saveAutoModeState();
    queueAutoModeCycle(autoModeState.currentQueueItemId ? JobCopilotAutoRefillPolicy.AUTO_REFILL_RETRY_MS : 0);
    return;
  }

  const nextItem = await getNextAutoQueueItem();
  if (nextItem && nextItem.id) {
    await processOneQueueItem(nextItem);
    return;
  }

  autoModeState.phase = "idle";
  await saveAutoModeState();
  const retryDelay = JobCopilotAutoRefillPolicy.resolveRetryDelay(autoModeState.enabled, false);
  if (retryDelay >= 0) {
    queueAutoModeCycle(retryDelay);
  }
}

// 功能目的：把单个岗位推进到自动聊天；实现原因：无障碍流程需要从“待投递”直接进入自动沟通。
async function processOneQueueItem(item) {
  const queueItem = await ensureAutoQueueItemPrepared(item);
  if (!queueItem) {
    return;
  }
  if (!queueItem.url) {
    await markQueueItemRejected(item.id, "岗位链接缺失");
    queueAutoModeCycle(resolvePostChatDelay("rejected"));
    return;
  }

  autoModeState.phase = "chatting";
  autoModeState.currentQueueItemId = queueItem.id;
  autoModeState.currentJobId = queueItem.jobId || "";
  autoModeState.currentRound = 0;
  autoModeState.lastChatTime = Date.now();
  await saveAutoModeState();
  await sleep(JobCopilotAutoRefillPolicy.resolvePacedDelay(800, 1500, Math.random()));

  const autoChatURL = buildAutoChatURL(queueItem);
  const tab = await openOrReuseBossTab(autoChatURL, {
    active: false,
    preferredTabId: autoModeState.workTabId,
    excludeTabIds: [autoModeState.scanTabId, autoModeState.autoReplyTabId]
  });
  autoModeState.workTabId = tab.id;
  autoModeState.currentTabId = tab.id;
  await saveAutoModeState();

  kickAutoChatTab(tab.id, queueItem).catch((error) => {
    console.warn("[JobCopilot] Auto chat bootstrap fallback to URL only:", error.message || error);
  });

  // 内容脚本可能在 BOSS 的页面跳转中丢失完成回执。即使没有回执，也要在超时后
  // 重新进入调度循环，让 recoverTimedOutAutoChat 回收岗位并继续下一项。
  queueAutoModeCycle(JobCopilotAutoRefillPolicy.resolveAutoChatWatchdogDelay(AUTO_CHAT_TIMEOUT_MS));
}

async function ensureAutoQueueItemPrepared(item) {
  if (!item || !item.id) {
    return null;
  }
  if (item.openingDraft) {
    return item;
  }

  try {
    const preparePayload = await requestLocalJSON("/api/delivery/queue/prepare", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: item.id,
        resumeId: autoModeState.resumeId || "",
        mode: autoModeState.chatMode || DEFAULT_CHAT_MODE
      })
    });
    const preparedItem = preparePayload.item || item;
    if (preparedItem.openingDraft) {
      return preparedItem;
    }
  } catch (error) {
    appendAutoModeError("生成开场白失败: " + (error.message || item.id));
  }

  appendAutoModeError("自动生成开场白暂时失败，岗位保留并将在稍后重试: " + item.id);
  queueAutoModeCycle(resolvePostChatDelay("stopped"));
  return null;
}

function buildAutoChatURL(queueItem) {
  const hashParams = new URLSearchParams();
  hashParams.set("autoChat", "1");
  hashParams.set("queueItemId", queueItem.id || "");
  hashParams.set("jobId", queueItem.jobId || "");
  hashParams.set("draft", queueItem.openingDraft || "");
  hashParams.set("mode", autoModeState.chatMode || DEFAULT_CHAT_MODE);
  hashParams.set("title", queueItem.title || "");
  hashParams.set("company", queueItem.company || "");

  try {
    const targetURL = new URL(queueItem.url);
    targetURL.hash = hashParams.toString();
    return targetURL.toString();
  } catch (error) {
    const separator = String(queueItem.url || "").includes("#") ? "&" : "#";
    return String(queueItem.url || "") + separator + hashParams.toString();
  }
}

async function kickAutoChatTab(tabId, queueItem) {
  const ready = await waitForTabReady(tabId, 12000);
  if (!ready) {
    return;
  }

  await sleep(JobCopilotAutoRefillPolicy.resolvePacedDelay(500, 900, Math.random()));
  await ensureContentScript(tabId);
  await sleep(JobCopilotAutoRefillPolicy.resolvePacedDelay(250, 450, Math.random()));

  const response = await sendTabMessageSafe(tabId, {
    type: "startAutoChat",
    queueItemId: queueItem.id,
    jobId: queueItem.jobId || "",
    resumeId: queueItem.resumeId || autoModeState.resumeId || "",
    mode: autoModeState.chatMode || DEFAULT_CHAT_MODE,
    messages: [],
    roundCount: 0,
    maxRounds: autoModeState.maxChatRounds,
    openingDraft: queueItem.openingDraft || "",
    title: queueItem.title || "",
    company: queueItem.company || "",
    autoMode: true
  });

  if (response && response.ok === false) {
    throw new Error(response.error || "Auto chat bootstrap rejected");
  }
}

async function handleAutoChatCompleted(message) {
  const queueItemId = cleanText(message.queueItemId, 120);
  const status = cleanText(message.status, 20) || "completed";

  if (queueItemId) {
    await requestLocalJSON("/api/chat/auto/status", {
      method: "POST",
      body: JSON.stringify({ queueItemId, status })
    }).catch(() => {});
  }

  await stopCurrentAutomationTab();

  if (status === "completed") {
    autoModeState.totalChatted += 1;
  }
  autoModeState.currentQueueItemId = "";
  autoModeState.currentJobId = "";
  autoModeState.currentRound = normalizeCount(message.roundCount, 0, 0, 50);
  autoModeState.phase = "idle";
  autoModeState.lastChatTime = Date.now();
  await saveAutoModeState();

  if (autoModeState.enabled) {
    queueAutoModeCycle(resolvePostChatDelay(status));
  }
}

async function handleAutoSyncCompleted(message) {
  if (!message) {
    return;
  }
  const jobCount = normalizeCount(message.jobCount, 0, 0, 100000);
  if (jobCount > 0) {
    autoModeState.totalProcessed += jobCount;
    await saveAutoModeState();
  }
}

function buildOneClickScanStatusResponse() {
  return {
    running: oneClickScanState.running,
    status: oneClickScanState.status,
    totalJobsFound: oneClickScanState.totalJobsFound,
    totalPagesScrolled: oneClickScanState.totalPagesScrolled,
    totalInQueue: oneClickScanState.totalInQueue,
    totalBlocked: oneClickScanState.totalBlocked,
    lastError: oneClickScanState.lastError,
    elapsed: oneClickScanState.startTime ? Math.floor((Date.now() - oneClickScanState.startTime) / 1000) : 0
  };
}

function cancelOneClickScan() {
  if (!oneClickScanState.running) {
    return;
  }

  oneClickScanState.cancelRequested = true;
  oneClickScanState.status = "cancelled";
  oneClickScanState.lastError = "扫描已取消";

  if (oneClickScanState.createdTab && oneClickScanState.tabId) {
    chrome.tabs.remove(oneClickScanState.tabId).catch(() => {});
  }
}

// 功能目的：执行一键扫描入队；实现原因：系统页和插件弹窗都需要直接复用同一条扫描链路。
async function startOneClickFullScan(config) {
  if (oneClickScanState.running) {
    throw new Error("扫描任务正在运行，请等待结束或先取消。");
  }

  const scanConfig = normalizeScanConfig(config || {});
  oneClickScanState = {
    ...createDefaultOneClickScanState(),
    running: true,
    startTime: Date.now(),
    status: "opening"
  };

  try {
    const scanPayload = await collectBossJobs(scanConfig, {
      active: true,
      reuseExisting: true,
      stopAfterFirstNewBatch: autoModeState.enabled === true,
      onTabReady: (tabInfo) => {
        oneClickScanState.tabId = tabInfo.tabId;
        oneClickScanState.createdTab = tabInfo.createdTab;
      }
    });

    ensureScanNotCancelled();

    oneClickScanState.totalJobsFound = scanPayload.jobs.length;
    oneClickScanState.totalPagesScrolled = scanPayload.pagesScrolled;
    oneClickScanState.status = "analyzing";

    const eligibleJobs = (scanPayload.analyses || []).filter((item) => item && item.eligible && item.source).map((item) => item.source);
    oneClickScanState.totalBlocked = Math.max(0, scanPayload.jobs.length - eligibleJobs.length);

    if (eligibleJobs.length > 0) {
      oneClickScanState.status = "enqueuing";
      if (autoModeState.enabled) {
        oneClickScanState.totalInQueue = await enqueueEligibleJobsForAutoMode(eligibleJobs);
        queueAutoModeCycle(0);
      } else {
        const queuePayload = await requestLocalJSON("/api/delivery/queue/add", {
          method: "POST",
          body: JSON.stringify({
            jobs: eligibleJobs,
            candidateSkills: [],
            minScore: scanConfig.minScore,
            includeAll: false
          })
        });
        oneClickScanState.totalInQueue = Array.isArray(queuePayload.items) ? queuePayload.items.length : eligibleJobs.length;
      }
    }

    oneClickScanState.status = "done";
    return buildScanResult();
  } catch (error) {
    oneClickScanState.status = oneClickScanState.cancelRequested ? "cancelled" : "error";
    oneClickScanState.lastError = error.message || "扫描失败";
    throw error;
  } finally {
    oneClickScanState.running = false;
    oneClickScanState.cancelRequested = false;
  }
}

function buildScanResult() {
  return {
    totalJobsFound: oneClickScanState.totalJobsFound,
    totalPagesScrolled: oneClickScanState.totalPagesScrolled,
    totalInQueue: oneClickScanState.totalInQueue,
    totalBlocked: oneClickScanState.totalBlocked,
    elapsedSeconds: oneClickScanState.startTime ? Math.floor((Date.now() - oneClickScanState.startTime) / 1000) : 0,
    status: oneClickScanState.status
  };
}

function ensureScanNotCancelled() {
  if (oneClickScanState.cancelRequested) {
    throw new Error("扫描已取消");
  }
}

function normalizeScanConfig(config) {
  return {
    maxPages: normalizeCount(config.maxPages, DEFAULT_CONFIG.maxScrollPages, 1, 100),
    scrollDelay: normalizeCount(config.scrollDelay, DEFAULT_CONFIG.scrollDelayMs, 250, 5000),
    maxJobs: normalizeCount(config.maxJobs, DEFAULT_CONFIG.maxJobsPerScan, 1, 500),
    minScore: normalizeCount(config.minScore, 0, 0, 100),
    keyword: cleanText(config.keyword, 60) || DEFAULT_CONFIG.targetKeyword,
    city: cleanText(config.city, 40),
    minSalaryK: normalizeCount(config.minSalaryK, 0, 0, 300),
    maxSalaryK: normalizeCount(config.maxSalaryK, 0, 0, 300)
  };
}

async function pullBossJobsOnly(options) {
  const scanConfig = normalizeScanConfig({
    maxPages: options.maxScrolls || 6,
    scrollDelay: options.scrollDelay || DEFAULT_CONFIG.scrollDelayMs,
    minScore: options.minScore || 0,
    keyword: options.keyword || DEFAULT_CONFIG.targetKeyword,
    city: options.city || ""
  });

  const scanPayload = await collectBossJobs(scanConfig, {
    active: true,
    reuseExisting: true
  });

  return {
    jobCount: scanPayload.jobs.length,
    jobs: scanPayload.jobs
  };
}

async function collectBossJobs(config, options) {
  const scanConfig = await resolveBossScanConfig(normalizeScanConfig(config || {}));
  const openOptions = options || {};
  const bossTab = await openBossJobsTab(buildBossJobsSearchURL(
    scanConfig.keyword,
    scanConfig.city,
    scanConfig.salaryCode,
    scanConfig.positionCode,
    scanConfig.jobTypeCode
  ), {
    active: openOptions.active === true,
    reuseExisting: openOptions.reuseExisting === true,
    preferredTabId: openOptions.preferredTabId,
    excludeTabIds: openOptions.excludeTabIds,
    preserveWorkTab: openOptions.preserveWorkTab === true
  });

  if (typeof openOptions.onTabReady === "function") {
    openOptions.onTabReady({ tabId: bossTab.id, createdTab: bossTab.createdTab });
  }

  oneClickScanState.tabId = bossTab.id;
  ensureScanNotCancelled();

  const ready = await waitForTabReady(bossTab.id, 12000);
  if (!ready) {
    throw new Error("BOSS 职位页加载超时，请确认网络和登录状态。");
  }

  await sleep(900);
  ensureScanNotCancelled();
  await ensureContentScript(bossTab.id);
  await sleep(350);
  oneClickScanState.status = "scrolling";

  const filterResult = await sendTabMessageSafe(bossTab.id, {
    type: "applyBossSearchFilters",
    keyword: scanConfig.keyword,
    city: scanConfig.city,
    minSalaryK: scanConfig.minSalaryK,
    maxSalaryK: scanConfig.maxSalaryK,
    positionCode: scanConfig.positionCode,
    positionLabel: scanConfig.positionLabel,
    positionCategory: scanConfig.positionCategory,
    jobTypeCode: scanConfig.jobTypeCode,
    jobTypeLabel: scanConfig.jobTypeLabel
  }, 15000);
  if (filterResult && filterResult.ok === false) {
    console.warn("[JobCopilot] BOSS filters were not fully applied:", filterResult.error || "unknown error");
  }

  const scanResult = await sendTabMessageSafe(bossTab.id, {
    type: "oneClickAutoScroll",
    maxPages: scanConfig.maxPages,
    scrollDelay: scanConfig.scrollDelay,
    maxJobs: scanConfig.maxJobs,
    stopAfterFirstNewBatch: openOptions.stopAfterFirstNewBatch === true
  }, LONG_TAB_MESSAGE_TIMEOUT_MS);
  if (!scanResult || !Array.isArray(scanResult.jobs)) {
    throw new Error("BOSS 页面脚本没有响应，请刷新职位页后重试。");
  }

  ensureScanNotCancelled();
  const jobs = scanResult.jobs || [];
  const pagesScrolled = normalizeCount(scanResult.pagesScrolled, 0, 0, DEFAULT_CONFIG.maxScrollPages);
  let analyses = [];

  if (jobs.length > 0) {
    const analyzePayload = await analyzeVisibleJobs(jobs, scanConfig.minScore);
    analyses = Array.isArray(analyzePayload.jobs) ? analyzePayload.jobs : [];
    await sendTabMessageSafe(bossTab.id, {
      type: "markVisibleJobs",
      jobs: analyses
    });
  }

  return {
    tabId: bossTab.id,
    createdTab: bossTab.createdTab,
    jobs,
    analyses,
    pagesScrolled
  };
}

async function resolveBossScanConfig(scanConfig) {
  const resolvedConfig = { ...scanConfig };
  if (resolvedConfig.minSalaryK <= 0 && resolvedConfig.maxSalaryK <= 0) {
    try {
      const strategyPayload = await requestLocalJSON("/api/delivery/strategy", { method: "GET" });
      const strategy = strategyPayload && strategyPayload.strategy ? strategyPayload.strategy : {};
      resolvedConfig.minSalaryK = normalizeCount(strategy.minSalaryK, 0, 0, 300);
      resolvedConfig.maxSalaryK = normalizeCount(strategy.maxSalaryK, 0, 0, 300);
    } catch (error) {
      console.warn("[JobCopilot] Failed to read salary strategy:", error.message || error);
    }
  }

  const salaryBand = JobCopilotBossSearchPolicy.resolveSalaryBand(
    resolvedConfig.minSalaryK,
    resolvedConfig.maxSalaryK
  );
  resolvedConfig.salaryCode = salaryBand ? salaryBand.code : "";
  const position = JobCopilotBossSearchPolicy.resolvePosition(resolvedConfig.keyword);
  resolvedConfig.positionCode = position ? position.code : "";
  resolvedConfig.positionLabel = position ? position.label : "";
  resolvedConfig.positionCategory = position ? position.category : "";
  const jobType = JobCopilotBossSearchPolicy.resolveJobType(resolvedConfig.keyword);
  resolvedConfig.jobTypeCode = jobType ? jobType.code : "";
  resolvedConfig.jobTypeLabel = jobType ? jobType.label : "";
  return resolvedConfig;
}

function buildBossJobsSearchURL(keyword, city, salaryCode, positionCode, jobTypeCode) {
  const queryParts = [];
  const resolvedCity = resolveBossCityQueryValue(city);
  if (keyword) {
    queryParts.push("query=" + encodeURIComponent(keyword));
  }
  if (resolvedCity) {
    queryParts.push("city=" + encodeURIComponent(resolvedCity));
  }
  if (/^\d{3,6}$/.test(String(salaryCode || ""))) {
    queryParts.push("salary=" + encodeURIComponent(String(salaryCode)));
  }
  if (/^\d{6}$/.test(String(positionCode || ""))) {
    queryParts.push("position=" + encodeURIComponent(String(positionCode)));
  }
  if (/^\d{4}$/.test(String(jobTypeCode || ""))) {
    queryParts.push("jobType=" + encodeURIComponent(String(jobTypeCode)));
  }
  if (queryParts.length === 0) {
    return BOSS_JOBS_URL;
  }
  return BOSS_JOBS_URL + "?" + queryParts.join("&");
}

function resolveBossCityQueryValue(city) {
  const normalizedCity = normalizeBossCityKey(city);
  if (!normalizedCity) {
    return "";
  }
  if (/^\d{6,12}$/.test(normalizedCity)) {
    return normalizedCity;
  }
  return BOSS_CITY_CODE_MAP[normalizedCity] || cleanText(city, 40);
}

function normalizeBossCityKey(city) {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/市$/u, "");
}

async function openBossJobsTab(searchURL, options) {
  const settings = options || {};
  if (settings.reuseExisting) {
    const reusableTab = await findReusableBossTab(settings.preferredTabId, 900, settings.excludeTabIds);
    if (reusableTab && reusableTab.id) {
      const updatedTab = await chrome.tabs.update(reusableTab.id, { url: searchURL, active: settings.active === true });
      if (!settings.preserveWorkTab) {
        autoModeState.workTabId = updatedTab.id;
        await saveAutoModeState();
      }
      if (updatedTab.windowId !== undefined && settings.active === true) {
        await chrome.windows.update(updatedTab.windowId, { focused: true }).catch(() => {});
      }
      return { ...updatedTab, createdTab: false };
    }
  }

  const createdTab = await chrome.tabs.create({ url: searchURL, active: settings.active === true });
  if (!settings.preserveWorkTab) {
    autoModeState.workTabId = createdTab.id;
    await saveAutoModeState();
  }
  return { ...createdTab, createdTab: true };
}

async function openOrReuseBossTab(targetURL, options) {
  const settings = options || {};
  const reusableTab = await findReusableBossTab(settings.preferredTabId, 300, settings.excludeTabIds);
  if (reusableTab && reusableTab.id) {
    const updatedTab = await chrome.tabs.update(reusableTab.id, {
      url: targetURL,
      active: settings.active === true
    });
    autoModeState.workTabId = updatedTab.id;
    await saveAutoModeState();
    return { ...updatedTab, createdTab: false };
  }

  const createdTab = await chrome.tabs.create({ url: targetURL, active: settings.active === true });
  autoModeState.workTabId = createdTab.id;
  await saveAutoModeState();
  return { ...createdTab, createdTab: true };
}

async function findReusableBossTab(preferredTabId, waitMs, excludeTabIds) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const excludedTabIds = new Set((Array.isArray(excludeTabIds) ? excludeTabIds : []).filter(Boolean));
  do {
    const existingTabs = await chrome.tabs.query({
      url: ["https://www.zhipin.com/*", "https://*.zhipin.com/*"]
    });
    const reusableTabs = existingTabs.filter((tab) => (
      (!autoModeState.autoReplyTabId || tab.id !== autoModeState.autoReplyTabId) &&
      !excludedTabIds.has(tab.id)
    ));
    const reusableTab = JobCopilotBossSearchPolicy.selectReusableBossTab(reusableTabs, preferredTabId);
    if (reusableTab) {
      return reusableTab;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(150);
  } while (Date.now() < deadline);
  return null;
}

async function analyzeVisibleJobs(jobs, minScore) {
  return requestLocalJSON("/api/jobs/visible/analyze", {
    method: "POST",
    body: JSON.stringify({
      jobs,
      candidateSkills: [],
      minScore
    })
  });
}

async function enqueueEligibleCapturedJobsFromLocalStore() {
  const payload = await requestLocalJSON("/api/jobs", { method: "GET" });
  const capturedJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const visibleJobs = capturedJobs.map((job) => ({
    clientId: job.id || job.url || "",
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    url: job.url || "",
    description: job.description || ""
  })).filter((job) => job.title || job.url);
  const analyzePayload = await analyzeVisibleJobs(visibleJobs, autoModeState.minMatchScore);
  const eligibleJobs = (analyzePayload.jobs || []).filter((item) => item && item.eligible && item.source).map((item) => item.source);
  return enqueueEligibleJobsForAutoMode(eligibleJobs);
}

async function enqueueEligibleJobsForAutoMode(eligibleJobs) {
  if (!Array.isArray(eligibleJobs) || eligibleJobs.length === 0) {
    return 0;
  }

  autoModeState.phase = "enqueuing";
  await saveAutoModeState();
  await requestLocalJSON("/api/delivery/queue/add", {
    method: "POST",
    body: JSON.stringify({
      jobs: eligibleJobs,
      candidateSkills: [],
      minScore: autoModeState.minMatchScore,
      includeAll: false
    })
  });
  return eligibleJobs.length;
}

async function getNextAutoQueueItem() {
  try {
    const payload = await requestLocalJSON("/api/delivery/queue/next-auto", { method: "GET" });
    return payload.item || null;
  } catch (error) {
    return null;
  }
}

async function markQueueItemSkipped(queueItemId, notes) {
  return markQueueItemStatus(queueItemId, "skipped", notes);
}

async function markQueueItemRejected(queueItemId, notes) {
  return markQueueItemStatus(queueItemId, "rejected", notes);
}

async function markQueueItemStatus(queueItemId, status, notes) {
  if (!queueItemId) {
    return;
  }
  await requestLocalJSON("/api/delivery/queue/status", {
    method: "POST",
    body: JSON.stringify({
      queueItemId,
      status,
      notes: cleanText(notes, 300)
    })
  }).catch(() => {});
}

async function stopCurrentAutomationTab() {
  if (!autoModeState.currentTabId) {
    return;
  }

  try {
    await sendTabMessageSafe(autoModeState.currentTabId, { type: "stopAutoChat" });
  } catch (error) {}

  autoModeState.currentTabId = null;
}

async function requestLocalJSON(path, options) {
  if (!String(path || "").startsWith("/api/")) {
    throw new Error("Only local API paths are allowed");
  }

  let lastError = null;
  for (const localServer of LOCAL_SERVERS) {
    try {
      const response = await fetch(localServer + path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...((options && options.headers) || {})
        }
      });
      const payload = await parseLocalJSONResponse(response, path);
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Local service unavailable");
}

// 功能目的：兜底解析本地服务响应；实现原因：旧版本服务返回纯文本时要给出明确错误而不是原生 JSON 异常。
async function parseLocalJSONResponse(response, path) {
  const responseText = await response.text();
  const trimmedText = String(responseText || "").trim();
  let payload = null;

  if (trimmedText !== "") {
    try {
      payload = JSON.parse(trimmedText);
    } catch (error) {
      throw new Error(buildLocalResponseError(path, response.status, trimmedText));
    }
  }

  if (!response.ok) {
    if (payload && typeof payload === "object" && payload.error) {
      throw new Error(payload.error);
    }
    throw new Error(buildLocalResponseError(path, response.status, trimmedText));
  }

  return payload;
}

// 功能目的：统一格式化本地服务错误；实现原因：扩展回传给系统页时必须是可读信息。
function buildLocalResponseError(path, statusCode, responseText) {
  const snippet = String(responseText || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (snippet) {
    return "Local API returned invalid response (" + statusCode + " " + path + "): " + snippet;
  }
  return "Local API returned invalid response (" + statusCode + " " + path + ")";
}

async function openSystemPage() {
  const tabs = await chrome.tabs.query({ url: SYSTEM_PAGE_MATCHERS });
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: SYSTEM_PAGE_URL, active: true });
    return;
  }

  const targetTab = tabs[0];
  const updatedTab = await chrome.tabs.update(targetTab.id, { url: SYSTEM_PAGE_URL, active: true });
  if (updatedTab.windowId !== undefined) {
    await chrome.windows.update(updatedTab.windowId, { focused: true }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessageSafe(tabId, message, timeoutMs) {
  const responseTimeoutMs = Math.max(TAB_MESSAGE_TIMEOUT_MS, Number(timeoutMs) || TAB_MESSAGE_TIMEOUT_MS);
  try {
    return await promiseWithTimeout(
      chrome.tabs.sendMessage(tabId, message),
      responseTimeoutMs,
      "标签页消息响应超时"
    );
  } catch (firstError) {
    try {
      await ensureContentScript(tabId);
      return await promiseWithTimeout(
        chrome.tabs.sendMessage(tabId, message),
        responseTimeoutMs,
        "标签页重试响应超时"
      );
    } catch (secondError) {
      return null;
    }
  }
}

async function ensureContentScript(tabId) {
  try {
    await promiseWithTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["boss-search-policy.js", "boss-chat-policy.js", "content.js"]
      }),
      TAB_MESSAGE_TIMEOUT_MS,
      "内容脚本注入超时"
    );
  } catch (error) {}
}

function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      reject(new Error(message || "操作超时"));
    }, Math.max(1, Number(timeoutMs) || TAB_MESSAGE_TIMEOUT_MS));

    Promise.resolve(promise).then((value) => {
      clearTimeout(timerId);
      resolve(value);
    }, (error) => {
      clearTimeout(timerId);
      reject(error);
    });
  });
}

function waitForTabReady(tabId, timeoutMs) {
  const deadlineTime = Date.now() + (timeoutMs || 15000);
  return new Promise((resolve) => {
    function checkTabReady() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(false);
          return;
        }
        if (tab.status === "complete") {
          resolve(true);
          return;
        }
        if (Date.now() >= deadlineTime) {
          resolve(false);
          return;
        }
        setTimeout(checkTabReady, 200);
      });
    }
    checkTabReady();
  });
}

async function executeBatchAutoSendAll(config) {
  if (batchAutoSendState.running) {
    throw new Error("Batch send is already running");
  }

  const waitBetweenMs = normalizeCount(config.waitBetweenMs, 1500, 800, 10000);
  const maxItems = normalizeCount(config.maxItems, 0, 0, 500);
  batchAutoSendState = {
    ...createDefaultBatchAutoSendState(),
    running: true
  };

  try {
    const queuePayload = await requestLocalJSON("/api/delivery/queue", { method: "GET" });
    let items = Array.isArray(queuePayload.items) ? queuePayload.items.filter(isBatchSendCandidate) : [];
    if (maxItems > 0) {
      items = items.slice(0, maxItems);
    }
    if (items.length === 0) {
      throw new Error("No queue items are available for batch send");
    }

    batchAutoSendState.totalItems = items.length;
    console.log("[JobCopilot] Batch send started with " + items.length + " items");

    for (let index = 0; index < items.length; index += 1) {
      if (batchAutoSendState.cancelRequested) {
        console.log("[JobCopilot] Batch send cancelled");
        break;
      }

      let queueItem = items[index];
      batchAutoSendState.currentIndex = index + 1;
      batchAutoSendState.currentItem = `${queueItem.company || "未知公司"} - ${queueItem.title || "未知岗位"}`;

      if (!queueItem.url) {
        batchAutoSendState.totalSkipped += 1;
        continue;
      }

      if (!queueItem.openingDraft) {
        try {
          const preparePayload = await requestLocalJSON("/api/delivery/queue/prepare", {
            method: "POST",
            body: JSON.stringify({
              queueItemId: queueItem.id,
              resumeId: autoModeState.resumeId || "",
              mode: autoModeState.chatMode || DEFAULT_CHAT_MODE
            })
          });
          queueItem = preparePayload.item || queueItem;
        } catch (error) {
          batchAutoSendState.totalSkipped += 1;
          continue;
        }
      }

      if (!queueItem.openingDraft) {
        batchAutoSendState.totalSkipped += 1;
        continue;
      }

      let tab = null;
      try {
        tab = await openOrReuseBossTab(queueItem.url, {
          active: false,
          preferredTabId: autoModeState.workTabId
        });
        const ready = await waitForTabReady(tab.id, 12000);
        if (!ready) {
          throw new Error("岗位页面加载超时");
        }

        await sleep(450);
        await ensureContentScript(tab.id);
        await sleep(500);

        const sendResult = await chrome.tabs.sendMessage(tab.id, {
          type: "autoSendDraft",
          text: queueItem.openingDraft,
          queueItemId: queueItem.id,
          sendKey: "batch-auto-send|" + queueItem.id,
          label: "Batch opening draft",
          deliveryNote: "Batch auto delivery completed"
        });

        if (sendResult && sendResult.ok && (sendResult.sent || sendResult.alreadySent || sendResult.delivered)) {
          batchAutoSendState.totalSent += 1;
        } else {
          batchAutoSendState.totalSkipped += 1;
        }
      } catch (error) {
        console.warn("[JobCopilot] Batch send failed:", error.message || error);
        batchAutoSendState.totalSkipped += 1;
      }

      if (index < items.length - 1 && !batchAutoSendState.cancelRequested) {
        await sleep(waitBetweenMs);
      }
    }

    console.log(
      "[JobCopilot] Batch send finished: sent " +
      batchAutoSendState.totalSent +
      ", skipped " +
      batchAutoSendState.totalSkipped
    );
    return {
      totalSent: batchAutoSendState.totalSent,
      totalSkipped: batchAutoSendState.totalSkipped
    };
  } finally {
    batchAutoSendState.running = false;
    batchAutoSendState.cancelRequested = false;
    batchAutoSendState.currentIndex = 0;
    batchAutoSendState.totalItems = 0;
    batchAutoSendState.currentItem = "";
  }
}

function isBatchSendCandidate(item) {
  if (!item) {
    return false;
  }
  return item.status === "prepared" || item.status === "queued" || item.status === "opened";
}

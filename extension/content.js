var jobCopilotState = globalThis.jobCopilotState || {
  visibleCards: new Map(),
  listenerInstalled: false,
  panelInstalled: false,
  autoSyncKey: "",
  fillPollingStarted: false,
  fillPollingInitialTimer: null,
  fillPollingTimer: null,
  fillTaskInProgress: false,
  lastFilledQueueItemID: "",
  lastFilledAt: 0,
  lastCompletedTaskId: "",
  lastFillTaskCompleteAt: 0,
  lastAnySendAt: 0,
  openedCommunicationTasks: new Set(),
  sentDraftKeys: new Set(),
  activeSendKeys: new Set(),
  // 自动聊天相关状态
  autoChatEnabled: false,
  autoChatStartingQueueItemId: "",
  autoChatQueueItemId: "",
  autoChatJobId: "",
  autoChatResumeId: "",
  autoChatMode: "积极主动",
  autoChatAutoMode: false,
  autoChatMessages: [],
  autoChatRoundCount: 0,
  autoChatMaxRounds: 10,
  autoChatStatus: "idle", // idle / chatting / stopped / completed
  autoChatPollingTimer: null,
  autoChatLastHrMessage: "",
  autoChatLastHrMessageTime: 0,
  autoChatSentMessages: new Set(),
  autoChatSendInProgress: false,
  autoChatPendingReply: "",
  autoChatPendingRecruiterMessage: null,
  autoChatPendingHrKey: "",
  autoChatLastDraftText: "",
  autoChatProcessedHrKeys: new Set(),
  autoChatAwaitingHrReply: false,
  autoChatLastCandidateMessageKey: "",
  autoChatLastCandidateSendAt: 0,
  autoChatPendingReplySendKey: "",
  autoChatSendTimestamps: [],
  codexAutoReplyMonitorEnabled: false,
  codexAutoReplyRunning: false,
  codexAutoReplyPendingConversation: null,
  codexAutoReplyCurrentQueueItem: null,
  codexAutoReplyProcessedKeys: new Set(),
  codexAutoReplyNextActionAt: 0,
  codexAutoReplyLastListScrollAt: 0,
  // 自动发送简历相关
  autoSendResumeEnabled: false,
  autoSendResumeDone: false
};
globalThis.jobCopilotState = jobCopilotState;
if (!(jobCopilotState.openedCommunicationTasks instanceof Set)) {
  jobCopilotState.openedCommunicationTasks = new Set();
}
if (!(jobCopilotState.autoChatSentMessages instanceof Set)) {
  jobCopilotState.autoChatSentMessages = new Set();
}
if (!(jobCopilotState.sentDraftKeys instanceof Set)) {
  jobCopilotState.sentDraftKeys = new Set();
}
if (!(jobCopilotState.activeSendKeys instanceof Set)) {
  jobCopilotState.activeSendKeys = new Set();
}
if (typeof jobCopilotState.autoChatStartingQueueItemId !== "string") {
  jobCopilotState.autoChatStartingQueueItemId = "";
}
if (!(jobCopilotState.codexAutoReplyProcessedKeys instanceof Set)) {
  jobCopilotState.codexAutoReplyProcessedKeys = new Set();
}
loadSentDraftKeys();
loadCodexAutoReplyProcessedKeys();
const jobCopilotSystemPageURL = "http://127.0.0.1:8083/";
document.documentElement.setAttribute("data-job-copilot-content", "0.3.9");
startCodexAutoReplyLoopWhenReady();

// 功能目的：统一回写自动发送后的投递状态；实现原因：无障碍场景不能停留在“已填充”，必须明确标记为已送达。
async function markQueueItemDelivered(queueItemId, notes) {
  const cleanQueueItemId = String(queueItemId || "").trim();
  if (!cleanQueueItemId) {
    return false;
  }

  try {
    await requestLocalJSON("/api/delivery/queue/status", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: cleanQueueItemId,
        status: "delivered",
        notes: String(notes || "无障碍自动发送完成")
      })
    });
    return true;
  } catch (error) {
    showDraftFillNotice("送达状态回写失败: " + (error.message || "未知错误"));
    return false;
  }
}

// 功能目的：统一生成发送判重键；实现原因：批量发送、轮询补发和自动回复必须共享同一幂等规则。
function buildDraftGuardKeys(sendKey, draftText) {
  const baseKey = String(sendKey || makeDraftSendKey("draft", resolveConversationSendScope(""), draftText));
  return utilsUniqueKeys([
    baseKey,
    makeConversationDraftSendKey(baseKey, draftText)
  ]);
}

// 功能目的：识别草稿是否已经真实触发过发送；实现原因：需要区分“本次刚发出”和“之前已成功发出”。
function hasRecordedDraftSend(sendKey, draftText) {
  const cleanDraftText = String(draftText || "").trim();
  if (!cleanDraftText) {
    return false;
  }
  return hasAnySendKey(buildDraftGuardKeys(sendKey, cleanDraftText), jobCopilotState.sentDraftKeys);
}

// 功能目的：把填充和发送合并成原子动作；实现原因：后台批量投递不能依赖第二次点击消息发送按钮。
async function fillAndAutoSendDraft(draftText, options) {
  const cleanDraftText = String(draftText || "");
  const settings = options || {};
  const sendKey = String(settings.sendKey || makeDraftSendKey("message", location.href, cleanDraftText));
  const label = String(settings.label || "消息草稿");

  const fillResult = fillDraft(cleanDraftText);
  if (!fillResult.ok) {
    return fillResult;
  }

  const alreadySent = hasRecordedDraftSend(sendKey, cleanDraftText);
  if (!alreadySent) {
    await sleep(600);
  }

  const sent = alreadySent ? false : sendDraftOnce(sendKey, label);
  const delivered = hasRecordedDraftSend(sendKey, cleanDraftText);
  if (delivered && settings.queueItemId) {
    await markQueueItemDelivered(settings.queueItemId, settings.deliveryNote || "无障碍自动发送完成");
  }

  return {
    ok: true,
    sent: sent,
    alreadySent: alreadySent,
    delivered: delivered,
    input: fillResult.input
  };
}

// 功能目的：填充任务完成后按真实发送结果回写送达；实现原因：避免只填入未发出却被误判成功。
async function completeFillTaskAndMaybeMarkDelivered(queueItemId, draftText, sendKey, deliveryNote) {
  await completeFillTask(queueItemId);
  if (!hasRecordedDraftSend(sendKey, draftText)) {
    return false;
  }
  return markQueueItemDelivered(queueItemId, deliveryNote);
}

// 功能目的：统一结束自动聊天；实现原因：停止、完成、跳过都必须终止轮询并把最终状态通知后台。
function finishAutoChatSession(status, message) {
  const finalStatus = String(status || "completed");
  const queueItemId = jobCopilotState.autoChatQueueItemId;

  clearPendingAutoChatTask(queueItemId);
  jobCopilotState.autoChatEnabled = false;
  jobCopilotState.autoChatStatus = finalStatus;
  if (jobCopilotState.autoChatPollingTimer) {
    window.clearInterval(jobCopilotState.autoChatPollingTimer);
    jobCopilotState.autoChatPollingTimer = null;
  }
  if (message) {
    showAutoChatNotice(message);
  }

  if (!queueItemId) {
    return;
  }
  void notifyBackgroundByBridge("autoChatCompleted", {
    queueItemId: queueItemId,
    status: finalStatus,
    roundCount: jobCopilotState.autoChatRoundCount
    }, 15000);
}

// 功能目的：保存自动聊天任务；实现原因：BOSS 点击沟通后会跳转到聊天页，原详情页脚本会被销毁。
function persistAutoChatTask(config) {
  try {
    const task = {
      queueItemId: String(config.queueItemId || ""),
      jobId: String(config.jobId || ""),
      resumeId: String(config.resumeId || ""),
      mode: String(config.mode || "积极主动"),
      openingDraft: String(config.openingDraft || ""),
      title: String(config.title || ""),
      company: String(config.company || ""),
      maxRounds: Number(config.maxRounds || jobCopilotState.autoChatMaxRounds || 10),
      autoMode: config.autoMode === true,
      createdAt: Date.now()
    };
    if (!task.queueItemId || !task.jobId) {
      return;
    }
    safeSessionStorageSet("jobCopilotAutoChatTask", JSON.stringify(task));
    safeSessionStorageSet("jobCopilotTask", task.queueItemId);
    safeSessionStorageSet("jobCopilotDraft", task.openingDraft);
  } catch (e) {}
}

// 功能目的：读取跨页面自动聊天任务；实现原因：聊天页没有 URL hash 时仍要继续当前队列项。
function readPendingAutoChatTask() {
  try {
    const rawValue = sessionStorage.getItem("jobCopilotAutoChatTask") || "";
    if (!rawValue) {
      return null;
    }
    const task = JSON.parse(rawValue);
    if (!task || !task.queueItemId || !task.jobId) {
      return null;
    }
    if (Date.now() - Number(task.createdAt || 0) > 5 * 60 * 1000) {
      sessionStorage.removeItem("jobCopilotAutoChatTask");
      sessionStorage.removeItem("jobCopilotTask");
      sessionStorage.removeItem("jobCopilotDraft");
      return null;
    }
    return task;
  } catch (e) {
    return null;
  }
}

// 功能目的：清理已结束任务；实现原因：避免旧队列项在后续聊天页误恢复。
function clearPendingAutoChatTask(queueItemId) {
  try {
    const rawValue = sessionStorage.getItem("jobCopilotAutoChatTask") || "";
    const task = rawValue ? JSON.parse(rawValue) : null;
    if (queueItemId && task && task.queueItemId && task.queueItemId !== queueItemId) {
      return;
    }
    sessionStorage.removeItem("jobCopilotAutoChatTask");
    sessionStorage.removeItem("jobCopilotTask");
    sessionStorage.removeItem("jobCopilotDraft");
  } catch (e) {}
}

function safeSessionStorageSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (error) {
    cleanupBrowserSideStorage();
    try {
      sessionStorage.setItem(key, value);
    } catch (retryError) {}
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    cleanupBrowserSideStorage();
    try {
      localStorage.setItem(key, value);
    } catch (retryError) {}
  }
}

function cleanupBrowserSideStorage() {
  try {
    trimStoredJSONList(sessionStorage, "jobCopilotSentDraftKeys", 80);
    trimStoredJSONList(localStorage, "jobCopilotSentDraftKeys", 80);
    trimStoredJSONList(localStorage, "jobCopilotAutoResumeSentKeys", 80);
    sessionStorage.removeItem("jobCopilotDraft");
    if (!location.href.includes("/web/geek/chat")) {
      sessionStorage.removeItem("jobCopilotAutoChatTask");
    }
  } catch (error) {}
}

function trimStoredJSONList(storage, key, limit) {
  if (!storage) {
    return;
  }
  const rawValue = storage.getItem(key);
  if (!rawValue) {
    return;
  }
  let values = [];
  try {
    values = JSON.parse(rawValue);
  } catch (error) {
    storage.removeItem(key);
    return;
  }
  if (!Array.isArray(values)) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(values.slice(-Math.max(1, limit || 80))));
}

// 功能目的：聊天页自动恢复队列任务；实现原因：详情页跳转后必须继续填入或确认已发出的招呼。
function resumeAutoChatFromStorage() {
  if (!isBossPage() || !location.pathname.includes("/web/geek/chat")) {
    return;
  }
  if (jobCopilotState.autoChatRestoring || jobCopilotState.autoChatStatus === "chatting") {
    return;
  }

  const task = readPendingAutoChatTask();
  if (!task) {
    return;
  }

  jobCopilotState.autoChatRestoring = true;
  showAutoChatNotice("已进入聊天页，恢复自动投递任务...");
  window.setTimeout(function() {
    jobCopilotState.autoChatRestoring = false;
    startAutoChat({
      queueItemId: task.queueItemId,
      jobId: task.jobId,
      resumeId: task.resumeId || "",
      mode: task.mode || "积极主动",
      messages: [],
      roundCount: 0,
      maxRounds: task.maxRounds || jobCopilotState.autoChatMaxRounds || 10,
      openingDraft: task.openingDraft || "",
      title: task.title || "",
      company: task.company || "",
      autoMode: task.autoMode !== false
    }).catch(function(error) {
      showAutoChatNotice("恢复自动聊天失败: " + (error.message || "未知错误"));
    });
  }, 700);
}

if (!jobCopilotState.listenerInstalled) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "extractJob") {
      sendResponse(extractJobFromPage());
      return true;
    }

    if (message.type === "extractVisibleJobs") {
      sendResponse({ jobs: extractVisibleJobsFromPage() });
      return true;
    }

    if (message.type === "markVisibleJobs") {
      markVisibleJobs(message.jobs || []);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "fillDraft") {
      var result = fillDraft(message.text || "");
      if (result.ok) {
        const sendKey = makeDraftSendKey("message", location.href, message.text || "");
        setTimeout(function() {
          sendDraftOnce(sendKey, "消息草稿");
        }, 600);
      }
      sendResponse(result);
      return true;
    }

    // 自动聊天指令
    if (message.type === "autoSendDraft") {
      fillAndAutoSendDraft(message.text || "", {
        sendKey: message.sendKey || makeDraftSendKey("message", location.href, message.text || ""),
        label: message.label || "消息草稿",
        queueItemId: message.queueItemId || "",
        deliveryNote: message.deliveryNote || ""
      }).then(function(result) {
        sendResponse(result);
      }).catch(function(error) {
        sendResponse({ ok: false, error: error.message || "自动发送失败" });
      });
      return true;
    }

    if (message.type === "sendDraft") {
      const sendKey = String(message.sendKey || "");
      const draftText = String(message.text || "");
      const sent = sendDraftOnce(sendKey, message.label || "消息草稿");
      sendResponse({
        ok: true,
        sent: sent,
        alreadySent: !sent && hasRecordedDraftSend(sendKey, draftText),
        delivered: hasRecordedDraftSend(sendKey, draftText)
      });
      return true;
    }

    if (message.type === "startAutoChat") {
      void startAutoChat(message).catch((err) => {
        console.error("[JobCopilot] Auto chat start failed:", err.message || err);
      });
      sendResponse({ ok: true, started: true });
      return false;
    }

    if (message.type === "stopAutoChat") {
      stopAutoChat();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "getAutoChatStatus") {
      sendResponse({
        status: jobCopilotState.autoChatStatus,
        roundCount: jobCopilotState.autoChatRoundCount,
        messages: jobCopilotState.autoChatMessages
      });
      return true;
    }

    if (message.type === "startCodexAutoReplyMonitor") {
      jobCopilotState.codexAutoReplyMonitorEnabled = true;
      jobCopilotState.autoChatResumeId = String(message.resumeId || jobCopilotState.autoChatResumeId || "");
      jobCopilotState.autoChatMode = String(message.mode || jobCopilotState.autoChatMode || "积极主动");
      jobCopilotState.autoChatMaxRounds = Number(message.maxRounds || jobCopilotState.autoChatMaxRounds || 10);
      codexAutoReplyTick().catch(function(error) {
        showAutoChatNotice("Codex 自动回复监视器启动失败：" + (error.message || "未知错误"));
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "stopCodexAutoReplyMonitor") {
      jobCopilotState.codexAutoReplyMonitorEnabled = false;
      jobCopilotState.codexAutoReplyPendingConversation = null;
      jobCopilotState.codexAutoReplyCurrentQueueItem = null;
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "applyBossSearchFilters") {
      applyBossSearchFilters(message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message || "自动填写筛选条件失败" }));
      return true;
    }

    // 自动翻页扫描指令
    if (message.type === "autoScrollAndSync") {
      autoScrollAndSync(message.maxScrolls || 6, message.scrollDelay || 1200)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ jobCount: 0, error: err.message }));
      return true;
    }

    // 一键全自动扫描：翻页+抓取，不分批同步（由background统一提交）
    if (message.type === "oneClickAutoScroll") {
      oneClickAutoScroll(
        message.maxPages || 6,
        message.scrollDelay || 1200,
        message.maxJobs || 500,
        message.stopAfterFirstNewBatch === true
      )
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ jobs: [], pagesScrolled: 0, error: err.message }));
      return true;
    }

    return false;
  });
  jobCopilotState.listenerInstalled = true;
}

installBossSyncPanelWhenReady();
startPendingDraftPolling();
scheduleCommunicationOpenFromURL();
checkAutoChatFromURL();
resumeAutoChatFromStorage();

// 功能目的：等待页面可操作后挂载同步入口；实现原因：用户应在 BOSS 页面直接把岗位同步到系统。
function installBossSyncPanelWhenReady() {
  if (!isBossJobsPage() || jobCopilotState.panelInstalled) {
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installBossSyncPanel, { once: true });
    return;
  }
  installBossSyncPanel();
}

// 功能目的：在 BOSS 页面提供同步按钮；实现原因：系统页不能跨站读取 BOSS DOM。
function installBossSyncPanel() {
  if (!isBossJobsPage()) {
    return;
  }

  injectPanelStyle();
  const existingPanel = document.getElementById("job-copilot-panel");
  if (existingPanel) {
    upgradeBossSyncPanel(existingPanel);
    jobCopilotState.panelInstalled = true;
    scheduleAutoSyncVisibleJobs(0);
    return;
  }

  const panel = document.createElement("div");
  panel.id = "job-copilot-panel";
  panel.innerHTML = `
    <button id="job-copilot-sync-button" type="button">同步岗位到系统</button>
    <button id="job-copilot-open-button" type="button">打开系统</button>
    <span id="job-copilot-sync-status">抓当前可见岗位</span>
  `;
  document.body.appendChild(panel);
  upgradeBossSyncPanel(panel);
  jobCopilotState.panelInstalled = true;
  scheduleAutoSyncVisibleJobs(0);
}

// 功能目的：升级旧面板控件；实现原因：浏览器可能同时残留旧内容脚本创建的面板。
function upgradeBossSyncPanel(panel) {
  const syncButton = document.getElementById("job-copilot-sync-button");
  if (syncButton && syncButton.dataset.jobCopilotEnhanced !== "true") {
    syncButton.addEventListener("click", syncVisibleJobsToSystem);
    syncButton.dataset.jobCopilotEnhanced = "true";
  }

  let openButton = document.getElementById("job-copilot-open-button");
  if (!openButton) {
    openButton = document.createElement("button");
    openButton.id = "job-copilot-open-button";
    openButton.type = "button";
    openButton.textContent = "打开系统";
    const statusElement = document.getElementById("job-copilot-sync-status");
    panel.insertBefore(openButton, statusElement || null);
  }
  if (openButton.dataset.jobCopilotEnhanced !== "true") {
    openButton.addEventListener("click", handleOpenSystemButtonClick);
    openButton.dataset.jobCopilotEnhanced = "true";
  }
}

function isBossJobsPage() {
  return location.hostname.includes("zhipin.com") && location.pathname.includes("/web/geek/jobs");
}

function isBossPage() {
  return location.hostname.includes("zhipin.com");
}

// 功能目的：把当前页岗位同步到本地系统；实现原因：扫描、分析、入库必须由用户显式触发。
async function syncVisibleJobsToSystem() {
  const button = document.getElementById("job-copilot-sync-button");
  const systemWindow = openSystemWindow();
  setPanelStatus("正在抓取当前页岗位...");
  setPanelBusy(button, true);

  try {
    const jobs = extractVisibleJobsFromPage();
    if (jobs.length === 0) {
      setPanelStatus("当前页没有识别到岗位");
      return;
    }

    const payload = await requestLocalJSON("/api/jobs/visible/analyze", {
      method: "POST",
      body: JSON.stringify({
        jobs,
        candidateSkills: [],
        minScore: 0
      })
    });

    const analyses = payload.jobs || [];
    markVisibleJobs(analyses);
    const eligibleCount = analyses.filter((job) => job.eligible).length;
    setPanelStatus(`已入库 ${analyses.length} 个，建议 ${eligibleCount} 个，正在打开系统...`);
    await openSystemPageFromBoss(systemWindow);
    setPanelStatus(`已入库 ${analyses.length} 个，建议 ${eligibleCount} 个`);
  } catch (error) {
    setPanelStatus(error.message || "同步失败");
  } finally {
    setPanelBusy(button, false);
  }
}

// 功能目的：自动同步当前可见岗位；实现原因：用户打开 BOSS 页后系统应自动拿到岗位库数据。
function scheduleAutoSyncVisibleJobs(attemptIndex) {
  if (!isBossJobsPage() || attemptIndex > 10) {
    return;
  }

  window.setTimeout(async () => {
    const jobs = extractVisibleJobsFromPage();
    if (jobs.length === 0) {
      scheduleAutoSyncVisibleJobs(attemptIndex + 1);
      return;
    }

    const syncKey = `${location.href}#${jobs.map((job) => job.url || job.title).join("|")}`;
    if (jobCopilotState.autoSyncKey === syncKey) {
      return;
    }
    jobCopilotState.autoSyncKey = syncKey;

    setPanelStatus("已识别岗位，自动同步中...");
    try {
      const payload = await requestLocalJSON("/api/jobs/visible/analyze", {
        method: "POST",
        body: JSON.stringify({
          jobs,
          candidateSkills: [],
          minScore: 0
        })
      });
      const analyses = payload.jobs || [];
      markVisibleJobs(analyses);
      setPanelStatus(`自动同步 ${analyses.length} 个岗位`);
    } catch (error) {
      setPanelStatus(`自动同步失败：${error.message || "未知错误"}`);
    }
  }, 1200 + attemptIndex * 500);
}

// 功能目的：调用本地 Go 服务；实现原因：岗位分析和入库统一由后端处理。
async function requestLocalJSON(path, options, timeoutMs) {
  const response = await sendRuntimeMessage("requestLocalJSON", {
    path: path,
    options: options || {}
  }, timeoutMs || 10000);
  return response.payload;
}

function resolveBridgeClient() {
  const bridgeClient = globalThis.jobCopilotBridgeClient;
  if (!bridgeClient || typeof bridgeClient.sendCommand !== "function") {
    throw new Error("扩展桥接客户端未加载");
  }
  return bridgeClient;
}

function sendBridgeCommand(commandType, payload, timeoutMs) {
  return sendRuntimeMessage(commandType, payload || {}, timeoutMs || 15000);
}

function notifyBackgroundByBridge(commandType, payload, timeoutMs) {
  return sendRuntimeMessage(commandType, payload || {}, timeoutMs || 12000).catch(function() {
    return null;
  });
}

function sendRuntimeMessage(commandType, payload, timeoutMs) {
  return new Promise(function(resolve, reject) {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      reject(new Error("扩展后台通信不可用"));
      return;
    }

    var settled = false;
    var timer = window.setTimeout(function() {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("扩展后台通信超时"));
    }, timeoutMs || 15000);

    var message = Object.assign({}, payload || {}, { type: commandType });
    chrome.runtime.sendMessage(message, function(response) {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);

      var runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "扩展后台通信失败"));
        return;
      }
      if (!response || response.ok === false) {
        reject(new Error((response && response.error) || "扩展后台返回异常"));
        return;
      }
      resolve(response);
    });
  });
}

// 功能目的：轮询本地待填任务；实现原因：系统页不能直接跨域操作 BOSS 输入框。
function startPendingDraftPolling() {
  if (!isBossPage()) {
    return;
  }
  if (jobCopilotState.fillPollingTimer) {
    return;
  }

  jobCopilotState.fillPollingStarted = true;
  if (jobCopilotState.fillPollingInitialTimer) {
    window.clearTimeout(jobCopilotState.fillPollingInitialTimer);
  }
  jobCopilotState.fillPollingInitialTimer = window.setTimeout(pollPendingFillTask, 1200);
  jobCopilotState.fillPollingTimer = window.setInterval(pollPendingFillTask, 2500);
}

async function pollPendingFillTask() {
  if (jobCopilotState.fillTaskInProgress) {
    return;
  }

  // 防止与自动聊天模式冲突：如果自动聊天正在运行，不处理 fill-task
  if (jobCopilotState.autoChatEnabled && jobCopilotState.autoChatStatus === "chatting") {
    return;
  }

  // 防止短时间内重复处理同一任务
  const now = Date.now();
  if (jobCopilotState.lastFillTaskCompleteAt && (now - jobCopilotState.lastFillTaskCompleteAt < 5000)) {
    return;
  }

  jobCopilotState.fillTaskInProgress = true;
  try {
    const queueItemID = resolveFillTaskQueueItemID();
    const payload = await requestLocalJSON(`/api/delivery/fill-task?url=${encodeURIComponent(location.href)}&queueItemId=${encodeURIComponent(queueItemID)}`, {
      method: "GET"
    });
    if (!payload.task || !payload.task.draft) {
      return;
    }

    // 防止同一任务重复处理
    if (jobCopilotState.lastCompletedTaskId === payload.task.queueItemId) {
      return;
    }

    safeSessionStorageSet("jobCopilotTask", payload.task.queueItemId);

    const currentInput = findChatInput();
    const taskSendKey = makeDraftSendKey("fill-task", payload.task.queueItemId, payload.task.draft);

    if (currentInput && chatInputContainsDraft(currentInput, payload.task.draft)) {
      await sleep(400);
      sendDraftOnce(taskSendKey, "岗位话术");
      await completeFillTaskAndMaybeMarkDelivered(
        payload.task.queueItemId,
        payload.task.draft,
        taskSendKey,
        "无障碍自动发送岗位话术完成"
      );
      jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
      jobCopilotState.lastFillTaskCompleteAt = Date.now();
      return;
    }

    if (shouldWaitBeforeRefill(currentInput, payload.task.queueItemId)) {
      await sleep(400);
      sendDraftOnce(taskSendKey, "岗位话术");
      await completeFillTaskAndMaybeMarkDelivered(
        payload.task.queueItemId,
        payload.task.draft,
        taskSendKey,
        "无障碍自动发送岗位话术完成"
      );
      jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
      jobCopilotState.lastFillTaskCompleteAt = Date.now();
      return;
    }

    // 检查是否已经发送过这个任务的话术
    if (jobCopilotState.sentDraftKeys.has(taskSendKey)) {
      await completeFillTaskAndMaybeMarkDelivered(
        payload.task.queueItemId,
        payload.task.draft,
        taskSendKey,
        "无障碍自动发送已完成（幂等确认）"
      );
      jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
      return;
    }

    if (currentInput && chatInputContainsDraft(currentInput, payload.task.draft)) {
      await sleep(400);
      sendDraftOnce(taskSendKey, "岗位话术");
      jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
      jobCopilotState.lastFillTaskCompleteAt = Date.now();
      return;
    }

    if (shouldWaitBeforeRefill(currentInput, payload.task.queueItemId)) {
      await sleep(400);
      sendDraftOnce(taskSendKey, "岗位话术");
      jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
      jobCopilotState.lastFillTaskCompleteAt = Date.now();
      return;
    }

    const fillResult = fillDraft(payload.task.draft);
    if (!fillResult.ok) {
      const opened = openBossCommunication(payload.task.queueItemId);
      if (opened) {
        showDraftFillNotice("已点击继续沟通，等待输入框出现...");
        // 等待输入框出现后填入并自动发送
        var input = await waitForChatInput(8000);
        if (input) {
          await sleep(600);
          var retryFill = fillDraft(payload.task.draft);
          if (retryFill.ok) {
            jobCopilotState.lastFilledQueueItemID = payload.task.queueItemId;
            jobCopilotState.lastFilledAt = Date.now();
            await sleep(600);
            sendDraftOnce(taskSendKey, "岗位话术");
            await completeFillTaskAndMaybeMarkDelivered(
              payload.task.queueItemId,
              payload.task.draft,
              taskSendKey,
              "无障碍自动发送岗位话术完成"
            );
            showDraftFillNotice("AI 话术已自动发送");
            jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
            jobCopilotState.lastFillTaskCompleteAt = Date.now();
            return;
          }
        }
        showDraftFillNotice("沟通窗口已打开但未能填入，请检查页面");
      } else {
        showDraftFillNotice("话术已准备，进入 BOSS 沟通输入框后会自动填入");
      }
      return;
    }

    jobCopilotState.lastFilledQueueItemID = payload.task.queueItemId;
    jobCopilotState.lastFilledAt = Date.now();

    await sleep(600);
    var sent = sendDraftOnce(taskSendKey, "岗位话术");
    var delivered = await completeFillTaskAndMaybeMarkDelivered(
      payload.task.queueItemId,
      payload.task.draft,
      taskSendKey,
      "无障碍自动发送岗位话术完成"
    );
    jobCopilotState.lastCompletedTaskId = payload.task.queueItemId;
    jobCopilotState.lastFillTaskCompleteAt = Date.now();
    if (sent || delivered) {
      showDraftFillNotice("AI 话术已自动发送");
    } else {
      showDraftFillNotice("AI 话术已处理，本条不会重复发送");
    }
  } catch (error) {
    if (String(error.message || "").includes("本地服务")) {
      return;
    }
  } finally {
    jobCopilotState.fillTaskInProgress = false;
  }
}

// 功能目的：解析当前标签页待填任务；实现原因：URL 锚点不发给 BOSS，只给本地插件精确领取草稿。
function resolveFillTaskQueueItemID() {
  const hashParams = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
  const queueItemID = hashParams.get("jobCopilotTask") || "";
  if (queueItemID) {
    safeSessionStorageSet("jobCopilotTask", queueItemID);
    return queueItemID;
  }
  return sessionStorage.getItem("jobCopilotTask") || "";
}

// 功能目的：标记填草稿任务完成，防止重复发送。
async function completeFillTask(queueItemId) {
  try {
    await requestLocalJSON("/api/delivery/fill-task/complete", {
      method: "POST",
      body: JSON.stringify({ queueItemId: queueItemId, status: "filled" })
    });
  } catch (e) {
    // 静默忽略
  }
}

// 功能目的：加载已发送键；实现原因：页面轮询和重复消息不能触发同一草稿多次发送。
function loadSentDraftKeys() {
  try {
    const rawValue = sessionStorage.getItem("jobCopilotSentDraftKeys") || "[]";
    JSON.parse(rawValue).forEach(function(key) {
      if (key) {
        jobCopilotState.sentDraftKeys.add(key);
      }
    });
  } catch (e) {}
}

// 功能目的：持久化已发送键；实现原因：同一页面生命周期内重复轮询要保持幂等。
function saveSentDraftKeys() {
  try {
    safeSessionStorageSet("jobCopilotSentDraftKeys", JSON.stringify(Array.from(jobCopilotState.sentDraftKeys).slice(-200)));
  } catch (e) {}
}

// 功能目的：生成草稿发送键；实现原因：按任务和内容去重，避免重复插入和重复点击发送。
function makeDraftSendKey(scope, identifier, draftText) {
  return [
    String(scope || "draft"),
    String(identifier || location.href).slice(0, 160),
    hashDraftText(draftText)
  ].join("|");
}

// 功能目的：压缩草稿内容用于去重；实现原因：直接存长文本浪费空间且不利于比较。
function hashDraftText(draftText) {
  const text = normalizeComparableText(String(draftText || "")).slice(0, 500);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// 功能目的：同一草稿只发送一次；实现原因：轮询和聊天助手可能在短时间内重复触发。
function sendDraftOnce(sendKey, label) {
  const key = String(sendKey || "");
  if (!key) {
    return clickSendButton();
  }
  if (jobCopilotState.sentDraftKeys.has(key) || jobCopilotState.activeSendKeys.has(key)) {
    showAutoChatNotice((label || "草稿") + "已触发过发送，本次跳过");
    return false;
  }

  jobCopilotState.activeSendKeys.add(key);
  try {
    const sent = clickSendButton();
    jobCopilotState.sentDraftKeys.add(key);
    saveSentDraftKeys();
    return sent;
  } finally {
    jobCopilotState.activeSendKeys.delete(key);
  }
}

// 功能目的：根据 URL 待填任务主动打开沟通框；实现原因：详情页需要先点击继续沟通，不能只等待输入框出现。
function scheduleCommunicationOpenFromURL() {
  if (!isBossPage() || location.pathname.includes("/web/geek/chat")) {
    return;
  }

  const queueItemID = readFillTaskQueueItemIDFromHash();
  if (!queueItemID) {
    return;
  }

  safeSessionStorageSet("jobCopilotTask", queueItemID);
  const deadlineTime = Date.now() + 45000;

  function retryOpenCommunication() {
    if (location.pathname.includes("/web/geek/chat") || findChatInput()) {
      return;
    }

    const opened = openBossCommunication(queueItemID);
    if (opened) {
      showDraftFillNotice("已点击继续沟通，等待输入框出现后自动填入");
      return;
    }

    if (Date.now() < deadlineTime) {
      window.setTimeout(retryOpenCommunication, 1200);
    }
  }

  window.setTimeout(retryOpenCommunication, 800);
}

// 功能目的：只读取 URL 中的待填任务编号；实现原因：避免 sessionStorage 旧任务误触发其他岗位页。
function readFillTaskQueueItemIDFromHash() {
  const hashParams = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
  return hashParams.get("jobCopilotTask") || "";
}

// 功能目的：显示填充状态；实现原因：用户必须清楚最终发送仍需人工确认。
function showDraftFillNotice(message) {
  let notice = document.getElementById("job-copilot-fill-notice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "job-copilot-fill-notice";
    notice.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:12px 14px;border-radius:8px;background:#111827;color:#fff;font-size:13px;box-shadow:0 8px 30px rgba(15,23,42,.28)";
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  window.setTimeout(() => {
    if (notice.textContent === message) {
      notice.remove();
    }
  }, 5000);
}

// 功能目的：打开 BOSS 沟通输入框；实现原因：详情页必须先进入沟通区域才能填入话术。
function openBossCommunication(queueItemID) {
  const taskKey = queueItemID || location.href;
  if (jobCopilotState.openedCommunicationTasks.has(taskKey)) {
    return false;
  }

  const communicationButton = findBossCommunicationButton();
  if (!communicationButton) {
    return false;
  }

  jobCopilotState.openedCommunicationTasks.add(taskKey);
  communicationButton.scrollIntoView({ block: "center", inline: "center" });
  safeClick(communicationButton);
  return true;
}

// 功能目的：单次点击页面元素；实现原因：重复派发 click 会导致筛选、沟通或发送动作刚触发又被撤销。
function safeClick(element) {
  if (element && typeof element.click === "function") {
    element.click();
  }
}

// 功能目的：定位继续沟通按钮；实现原因：BOSS 不同页面按钮标签不同但可见文案稳定。
function findBossCommunicationButton() {
  const candidates = [];
  const seenElements = new Set();
  document.querySelectorAll("button,a,[role='button'],div,span").forEach((element) => {
    const text = normalizeButtonText(element);
    if (!isCommunicationButtonText(text)) {
      return;
    }

    const clickableElement = normalizeClickableElement(element);
    if (!clickableElement || seenElements.has(clickableElement) || !isVisibleElement(clickableElement)) {
      return;
    }
    seenElements.add(clickableElement);
    candidates.push({ element: clickableElement, score: scoreCommunicationButton(text, clickableElement) });
  });

  candidates.sort((left, right) => right.score - left.score);
  return candidates.length > 0 ? candidates[0].element : null;
}

// 功能目的：筛选沟通按钮文案；实现原因：只打开聊天入口，不点击发送、交换联系方式或收藏。
function isCommunicationButtonText(text) {
  if (!text || text.length < 2 || text.length > 20) {
    return false;
  }
  // 功能目的：排除明显不是沟通按钮的文案；实现原因：避免误点发送、交换联系方式和页面容器。
  if (/发送|发简历|换电话|换微信|收藏|感兴趣|举报|分享|投递|申请/.test(text)) {
    return false;
  }
  return text.includes("继续沟通") || text.includes("立即沟通") || text === "沟通";
}

// 功能目的：归一化可点击节点；实现原因：按钮文字可能包在 span 内，实际点击目标在父级。
function normalizeClickableElement(element) {
  const nativeClickable = element.closest("button,a,[role='button']");
  if (nativeClickable) {
    return nativeClickable;
  }

  const childClickable = element.querySelector?.("a.btn-startchat,button,[role='button'],a[href]");
  if (childClickable && isVisibleElement(childClickable)) {
    return childClickable;
  }

  return element.closest(".btn,.op-btn,.chat-btn,.btn-startchat") || element;
}

// 功能目的：计算沟通按钮优先级；实现原因：已建立会话优先点继续沟通，减少新建会话副作用。
function scoreCommunicationButton(text, element) {
  const rect = element.getBoundingClientRect();
  let score = text.includes("继续沟通") ? 100 : text.includes("立即沟通") ? 80 : 50;
  if (rect.top < window.innerHeight * 0.45) {
    score += 20;
  }
  if (/primary|chat|start|沟通/i.test(String(element.className))) {
    score += 12;
  }
  return score;
}

// 功能目的：读取按钮可见文案；实现原因：BOSS 按钮可能使用 innerText、value 或无障碍标签。
function normalizeButtonText(element) {
  return [
    element.innerText,
    element.textContent,
    element.value,
    element.getAttribute("aria-label"),
    element.getAttribute("title")
  ].filter(Boolean).join(" ").replace(/\s+/g, "");
}

// 功能目的：判断元素是否可见；实现原因：避免点击隐藏模板或不可交互节点。
function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 12) {
    return false;
  }
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

// 功能目的：处理系统入口点击；实现原因：用户需要从 BOSS 页直接跳回本地工作台。
function handleOpenSystemButtonClick() {
  const systemWindow = openSystemWindow();
  openSystemPageFromBoss(systemWindow).catch((error) => {
    setPanelStatus(error.message || "打开系统失败");
  });
}

// 功能目的：直接打开系统页；实现原因：后台脚本缓存旧版时仍要保证用户点击有响应。
function openSystemWindow() {
  const systemWindow = window.open(jobCopilotSystemPageURL, "jobCopilotSystem");
  if (systemWindow) {
    systemWindow.focus();
  }
  return systemWindow;
}

// 功能目的：从 BOSS 页聚焦系统；实现原因：优先走扩展后台，失败时回退到普通浏览器打开。
async function openSystemPageFromBoss(systemWindow) {
  if (systemWindow) {
    systemWindow.location.href = jobCopilotSystemPageURL + "?syncedAt=" + Date.now();
    systemWindow.focus();
  }

  try {
    return await sendBridgeCommand("openSystemPage", {}, 12000);
  } catch (error) {
    if (systemWindow) {
      return { ok: true, fallback: true };
    }
    throw error;
  }
}

function setPanelBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  button.textContent = busy ? "同步中..." : "同步岗位到系统";
}

function setPanelStatus(message) {
  const status = document.getElementById("job-copilot-sync-status");
  if (status) {
    status.textContent = message;
  }
}

// 功能目的：注入同步面板样式；实现原因：入口必须稳定可见且不依赖 BOSS 样式。
function injectPanelStyle() {
  if (document.getElementById("job-copilot-panel-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "job-copilot-panel-style";
  style.textContent = `
    #job-copilot-panel{position:fixed;left:24px;bottom:24px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:#111827;color:#fff;box-shadow:0 8px 30px rgba(15,23,42,.28);font-size:13px}
    #job-copilot-sync-button{border:0;border-radius:6px;background:#0f766e;color:#fff;padding:9px 12px;font-weight:700;cursor:pointer}
    #job-copilot-open-button{border:1px solid rgba(255,255,255,.28);border-radius:6px;background:transparent;color:#fff;padding:8px 10px;font-weight:700;cursor:pointer}
    #job-copilot-sync-button:disabled{opacity:.72;cursor:wait}
    #job-copilot-sync-status{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d1d5db}
  `;
  document.head.appendChild(style);
}

// 功能目的：读取当前岗位页；实现原因：岗位详情页用于生成单岗位话术。
function extractJobFromPage() {
  const selectedJob = extractSelectedJobFromListPage();
  if (selectedJob) {
    return selectedJob;
  }

  const title = readFirstText([".job-detail-box .job-name", ".job-detail .job-name", ".job-title", ".job-name", ".name", "h1"]);
  const company = readFirstText([".job-detail-box .company-name", ".company-info .name", ".company-name", ".boss-info"]);
  const description = readJobDetailText() || document.body.innerText.slice(0, 12000);
  return { title, company, description, url: location.href };
}

// 功能目的：读取搜索结果页可见岗位；实现原因：只处理用户当前看到的岗位，避免无人值守刷页。
function extractVisibleJobsFromPage() {
  const cards = collectJobCards();
  jobCopilotState.visibleCards.clear();

  return cards.slice(0, 30).map((card, index) => {
    const clientId = `visible_${index}`;
    jobCopilotState.visibleCards.set(clientId, card);
    return buildVisibleJob(card, clientId);
  });
}

// 功能目的：收集岗位卡片节点；实现原因：BOSS 页面类名会变化，需要多选择器兜底。
function collectJobCards() {
  const selectors = [
    ".job-card-wrap",
    ".job-card-box",
    ".job-card-wrapper",
    ".job-list-box li",
    ".job-primary",
    ".job-card-body",
    "[class*='job-card']"
  ];
  const seenCards = new Set();
  const seenKeys = new Set();
  const cards = [];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((element) => {
      const card = normalizeJobCardElement(element);
      if (!card || seenCards.has(card) || !isLikelyJobCard(card)) {
        return;
      }
      const cardKey = buildCardUniqueKey(card);
      if (seenKeys.has(cardKey)) {
        return;
      }
      seenCards.add(card);
      seenKeys.add(cardKey);
      cards.push(card);
    });
  }

  if (cards.length > 0) {
    return cards;
  }

  document.querySelectorAll("a[href*='job_detail']").forEach((link) => {
    const card = normalizeJobCardElement(link.closest(".job-card-wrap, li, .job-card-wrapper, .job-primary, .job-card-body") || link.parentElement);
    if (card && !seenCards.has(card) && isLikelyJobCard(card)) {
      seenCards.add(card);
      cards.push(card);
    }
  });

  return cards;
}

// 功能目的：归一化岗位卡片节点；实现原因：新版 BOSS 会同时暴露外层 div 和内层 li。
function normalizeJobCardElement(element) {
  if (!element) {
    return null;
  }
  const wrapper = element.closest(".job-card-wrap");
  if (wrapper) {
    return wrapper;
  }
  const box = element.closest(".job-card-box");
  if (box) {
    return box;
  }
  return element;
}

// 功能目的：生成岗位去重键；实现原因：避免同一岗位外层和内层节点重复入队。
function buildCardUniqueKey(card) {
  const link = card.querySelector("a[href*='job_detail']");
  if (link) {
    return new URL(link.getAttribute("href"), locationHref()).href;
  }
  return (card.innerText || "").trim().replace(/\s+/g, " ").slice(0, 180);
}

// 功能目的：过滤非岗位节点；实现原因：降低搜索页广告和导航文本的误识别。
function isLikelyJobCard(element) {
  const text = (element.innerText || "").trim();
  if (text.length < 20 || text.length > 3000) {
    return false;
  }
  if (element.matches(".job-card-wrap, .job-card-box") && element.querySelector(".job-name, a[href*='job_detail']")) {
    return true;
  }
  if (element.querySelector(".job-name, a[href*='job_detail']")) {
    return true;
  }
  return /\d+\s*-\s*\d+\s*[Kk]|面议|经验|学历|本科|大专|薪/.test(text);
}

// 功能目的：读取双栏页面当前选中岗位；实现原因：右侧详情比左侧卡片包含更完整 JD。
function extractSelectedJobFromListPage() {
  const activeCard = document.querySelector(".job-card-wrap.active, .job-card-box.active");
  const detailText = readJobDetailText();
  if (!activeCard || !detailText) {
    return null;
  }

  const visibleJob = buildVisibleJob(activeCard, "active");
  return {
    title: visibleJob.title,
    company: visibleJob.company,
    description: visibleJob.description,
    url: visibleJob.url
  };
}

// 功能目的：组装岗位输入；实现原因：后端需要稳定字段计算匹配度。
function buildVisibleJob(card, clientId) {
  const title = readTextWithin(card, [".job-name", ".job-title", ".name", "a[href*='job_detail']", "a"]);
  const footerText = readTextWithin(card, [".job-card-footer", ".job-card-bottom", ".boss-info", "[class*='footer']"]);
  const company = readCompanyFromCard(card, footerText);
  const location = readLocationFromCard(card, footerText);
  const salary = readTextWithin(card, [".job-salary", ".salary", "[class*='salary']"]) || extractSalary(card.innerText || "");
  const link = card.querySelector("a[href*='job_detail'], a[href]");
  const url = link ? new URL(link.getAttribute("href"), locationHref()).href : location.href;
  const description = buildVisibleJobText(card);

  return {
    clientId,
    title,
    company,
    location,
    salary,
    url,
    description
  };
}

// 功能目的：合并岗位卡片和详情文本；实现原因：选中岗位需要用右侧完整 JD 提升匹配分析质量。
function buildVisibleJobText(card) {
  const cardText = (card.innerText || "").trim();
  if (!card.classList.contains("active")) {
    return cardText.slice(0, 2000);
  }

  const detailText = readJobDetailText();
  return [cardText, detailText].filter(Boolean).join("\n\n").slice(0, 5000);
}

// 功能目的：读取右侧岗位详情；实现原因：BOSS 搜索页详情不一定在独立详情页 URL。
function readJobDetailText() {
  return readFirstText([
    ".job-detail-box",
    ".job-detail-container",
    ".job-detail",
    ".job-sec-text",
    "[class*='job-detail']",
    "[class*='detail']"
  ], 12000);
}

// 功能目的：读取公司名称；实现原因：新版卡片公司和地点常混在 footer 中。
function readCompanyFromCard(card, footerText) {
  // 优先从专门的company选择器读取
  var companySelectors = [
    ".company-name a",
    ".company-name",
    ".company-text",
    ".company-info .name",
    ".company-info a",
    "[class*='company'] a",
    "[class*='company']"
  ];
  for (var i = 0; i < companySelectors.length; i++) {
    var el = card.querySelector(companySelectors[i]);
    if (el) {
      var text = (el.innerText || "").trim();
      if (text && text.length >= 2 && text.length <= 60) {
        // 排除纯地点文本
        if (!isLocationOnlyText(text)) {
          return removeLocationFromFooter(text);
        }
      }
    }
  }

  // 从footer中提取公司名（footer通常格式：公司名 地点·经验·学历）
  var footerRaw = footerText || readTextWithin(card, [
    ".job-card-footer",
    ".job-card-bottom",
    ".boss-info",
    "[class*='footer']",
    "[class*='bottom']"
  ]);
  if (footerRaw) {
    return removeLocationFromFooter(footerRaw);
  }

  // 最后尝试从整个卡片文本中解析
  var cardText = (card.innerText || "").trim();
  var lines = cardText.split(/\n/).filter(function(l) { return l.trim().length >= 2 && l.trim().length <= 60; });
  for (var j = 0; j < Math.min(lines.length, 5); j++) {
    var line = lines[j].trim();
    if (line && !isLocationOnlyText(line) && !isSalaryText(line) && !isTitleText(line)) {
      return removeLocationFromFooter(line);
    }
  }

  return "";
}

// 功能目的：判断文本是否为纯地点；实现原因：避免把"深圳·龙岗区·坂田"当公司名。
function isLocationOnlyText(text) {
  var t = String(text || "").trim();
  // 常见城市列表
  var cities = "北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|合肥|厦门|福州|宁波|东莞|佛山|珠海|青岛|济南|大连|无锡|常州|南通|嘉兴|绍兴|温州|台州|金华|南昌|昆明|贵阳|南宁|海口|石家庄|太原|沈阳|长春|哈尔滨|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特";
  // 如果文本主要由城市+区组成，且没有公司特征
  var cityPattern = new RegExp("^((" + cities + ")([·\\s]|$))+", "");
  if (cityPattern.test(t)) {
    return true;
  }
  // 全是地名模式
  if (/^[\u4e00-\u9fa5]+[·\s][\u4e00-\u9fa5]+(?:[·\s][\u4e00-\u9fa5]+)?$/.test(t) && t.length <= 15) {
    // 没有"科技"、"信息"、"公司"、"集团"等企业特征词
    if (!/科技|信息|技术|软件|网络|数据|智能|云|互联|数字|金融|医疗|教育|文化|传媒|咨询|服务|管理|投资|实业|集团|有限|股份|公司|科技|科技园|产业园|创客|孵化|众创|研发|制造|设计|工程|建筑|房地产|物业|物流|贸易|电商|跨境|生物|医药|化学|能源|环保|农业|食品|餐饮|旅游|酒店|保险|银行|证券|基金|汽车|航空|航天|通信|电子|半导体|芯片|光电|仪器|设备|机械|自动化|机器人|新能源|新材料/.test(t)) {
      return true;
    }
  }
  return false;
}

function isSalaryText(text) {
  return /\d+\s*-\s*\d+\s*[Kk]|面议|\d+薪/.test(String(text || ""));
}

function isTitleText(text) {
  var t = String(text || "").trim();
  return /工程师|经理|主管|总监|开发|设计|运营|产品|测试|前端|后端|Java|Python|Go|PHP|算法|数据|架构|运维|实习|应届|在校/.test(t);
}

// 功能目的：读取工作地点；实现原因：地点影响用户人工筛选优先级。
function readLocationFromCard(card, footerText) {
  const location = readTextWithin(card, [".job-area", ".job-location", ".area", "[class*='area']"]);
  if (location) {
    return location;
  }
  const match = String(footerText || "").match(/(北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|合肥|厦门|福州|宁波|东莞|佛山|珠海|青岛|济南|大连)(?:[·\s][^\s]+){0,3}/);
  return match ? match[0].trim() : "";
}

// 功能目的：清理 footer 里的地点片段；实现原因：公司字段不能混入办公地点。
function removeLocationFromFooter(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  
  // BOSS footer格式通常是: "公司名 城市·区域·地铁站 经验 学历"
  // 提取第一段作为公司名（在第一个城市+·之前）
  var cities = "北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|合肥|厦门|福州|宁波|东莞|佛山|珠海|青岛|济南|大连|无锡|常州|南通|嘉兴|绍兴|温州|台州|金华|南昌|昆明|贵阳|南宁|海口|石家庄|太原|沈阳|长春|哈尔滨";
  var locationStartPattern = new RegExp("\\s+(" + cities + ")(?:[·\\s]|$)", "");
  var match = text.match(locationStartPattern);
  if (match && match.index > 0) {
    text = text.substring(0, match.index).trim();
  }
  
  // 移除末尾的地点片段
  text = text
    .replace(new RegExp("\\s+(" + cities + ")(?:[·\\s][^\\s]+){0,3}$", ""), "")
    .trim()
    .slice(0, 120);
  
  return text;
}

// 功能目的：给搜索结果打标；实现原因：用户要直接看到哪些岗位值得优先处理。
function markVisibleJobs(jobs) {
  clearVisibleMarks();
  injectMarkStyle();

  jobs.forEach((job) => {
    const card = jobCopilotState.visibleCards.get(job.clientId);
    if (!card) {
      return;
    }

    card.classList.add(visibleJobClass(job));
    const badge = document.createElement("div");
    badge.className = "job-copilot-badge";
    badge.textContent = `${job.analysis.matchScore}｜${visibleJobLabel(job)}`;
    card.appendChild(badge);
  });
}

// 功能目的：清理旧标记；实现原因：重复扫描时避免页面残留多个徽标。
function clearVisibleMarks() {
  document.querySelectorAll(".job-copilot-badge").forEach((badge) => badge.remove());
  document.querySelectorAll(".job-copilot-high,.job-copilot-normal,.job-copilot-blocked").forEach((card) => {
    card.classList.remove("job-copilot-high", "job-copilot-normal", "job-copilot-blocked");
  });
}

// 功能目的：注入标记样式；实现原因：插件不依赖页面自身样式。
function injectMarkStyle() {
  if (document.getElementById("job-copilot-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "job-copilot-style";
  style.textContent = `
    .job-copilot-high,.job-copilot-normal,.job-copilot-blocked{position:relative!important}
    .job-copilot-high{outline:2px solid #0f766e!important;outline-offset:2px!important}
    .job-copilot-normal{outline:1px solid #cbd5e1!important;outline-offset:2px!important}
    .job-copilot-blocked{outline:2px solid #ef4444!important;outline-offset:2px!important}
    .job-copilot-badge{position:absolute;right:8px;top:8px;z-index:99999;padding:4px 8px;border-radius:6px;background:#0f766e;color:#fff;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(15,23,42,.18)}
  `;
  document.head.appendChild(style);
}

function visibleJobClass(job) {
  if (job.hardBlocked) {
    return "job-copilot-blocked";
  }
  if (job.eligible) {
    return "job-copilot-high";
  }
  return "job-copilot-normal";
}

function visibleJobLabel(job) {
  if (job.hardBlocked) {
    return "过滤";
  }
  if (job.eligible) {
    return "建议";
  }
  return "参考";
}

// 功能目的：填入聊天草稿；实现原因：发送动作必须由用户在页面上确认。
function fillDraft(text) {
  const draftText = String(text || "").trim();
  if (!draftText) {
    return { ok: false, error: "草稿内容不能为空" };
  }

  const input = findChatInput();
  if (!input) {
    return { ok: false, error: "未找到聊天输入框" };
  }

  input.focus();
  writeChatDraft(input, draftText);
  return { ok: true, target: describeChatInput(input) };
}

// 功能目的：判断草稿是否稳定留在输入框；实现原因：BOSS 聊天页会异步重渲染并清空刚写入的内容。
function chatInputContainsDraft(input, draftText) {
  const inputText = normalizeComparableText(readChatInputText(input));
  const expectedText = normalizeComparableText(draftText);
  if (!inputText || !expectedText) {
    return false;
  }
  return inputText.includes(expectedText.slice(0, Math.min(24, expectedText.length)));
}

// 功能目的：避免刚填入后立即反复覆盖；实现原因：用户可能正在检查或微调 AI 话术。
function shouldWaitBeforeRefill(input, queueItemID) {
  if (!input || jobCopilotState.lastFilledQueueItemID !== queueItemID) {
    return false;
  }
  if (Date.now() - jobCopilotState.lastFilledAt > 5000) {
    return false;
  }
  return readChatInputText(input).trim() !== "";
}

// 功能目的：读取聊天输入框文本；实现原因：textarea 和 contenteditable 的取值方式不同。
function readChatInputText(input) {
  if (!input) {
    return "";
  }
  if (input.isContentEditable) {
    return input.innerText || input.textContent || "";
  }
  return input.value || "";
}

// 功能目的：归一化比较文本；实现原因：BOSS 富文本会调整空白字符。
function normalizeComparableText(text) {
  return String(text || "").replace(/\s+/g, "");
}

// 功能目的：按候选选择器取页面文本；实现原因：招聘页面 DOM 会随版本变化。
function readFirstText(selectors, maxLength = 120) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = element && element.innerText ? element.innerText.trim() : "";
    if (text) {
      return text.slice(0, maxLength);
    }
  }
  return "";
}

// 功能目的：在卡片内部取文本；实现原因：减少跨卡片误读。
function readTextWithin(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = element && element.innerText ? element.innerText.trim() : "";
    if (text) {
      return text.split(/\r?\n/)[0].slice(0, 120);
    }
  }
  return "";
}

// 功能目的：提取薪资片段；实现原因：薪资影响岗位优先级展示。
function extractSalary(text) {
  const match = text.match(/\d+\s*-\s*\d+\s*[Kk](?:·\d+薪)?|面议|[0-9.]+万\s*-\s*[0-9.]+万/);
  return match ? match[0] : "";
}

// 功能目的：获取当前地址；实现原因：构造详情页绝对链接。
function locationHref() {
  return window.location.href;
}

// 功能目的：定位聊天输入框；实现原因：不同页面可能使用 textarea 或富文本输入，可能在主页面或iframe中。
function findChatInput() {
  const selectors = [
    ".chat-editor [contenteditable]",
    ".chat-editor textarea",
    ".chat-editor input[type='text']",
    ".chat-input [contenteditable]",
    ".chat-input textarea",
    ".chat-input input[type='text']",
    ".im-chat-editor [contenteditable]",
    ".im-chat-input [contenteditable]",
    ".im-chat-input textarea",
    ".im-chat-input input[type='text']",
    ".message-input [contenteditable]",
    ".message-input textarea",
    ".message-input input[type='text']",
    ".reply-input [contenteditable]",
    ".reply-input textarea",
    ".reply-input input[type='text']",
    ".input-area [contenteditable]",
    ".input-area textarea",
    ".input-area input[type='text']",
    "[class*='chat'] [role='textbox']",
    "[class*='chat'] textarea",
    "[class*='chat'] [contenteditable]",
    "[class*='chat'] input[type='text']",
    "[class*='message'] [contenteditable]",
    "[class*='message'] textarea",
    "[class*='message'] input[type='text']",
    "[class*='editor'] [contenteditable]",
    "[class*='editor'] textarea",
    "[class*='editor'] input[type='text']",
    "[class*='input'] [contenteditable]",
    "[class*='input'] textarea",
    "[class*='input'] input[type='text']",
    "[role='textbox'][contenteditable]",
    "[contenteditable='plaintext-only']",
    "[contenteditable='true']",
    "textarea[placeholder*='聊']",
    "textarea[placeholder*='回复']",
    "input[placeholder*='聊']",
    "input[placeholder*='回复']",
    "input[placeholder*='说']",
    "input[placeholder*='输入']",
    "textarea"
  ];
  const candidates = [];
  const seenElements = new Set();

  // 在主文档中搜索
  function searchInDocument(doc) {
    if (!doc) return;
    for (const selector of selectors) {
      try {
        doc.querySelectorAll(selector).forEach((element) => {
          if (seenElements.has(element) || !isLikelyChatInput(element)) {
            return;
          }
          seenElements.add(element);
          candidates.push({ element, score: scoreChatInput(element) });
        });
      } catch (e) {}
    }
  }

  searchInDocument(document);

  // 也搜索iframe内的输入框（BOSS聊天可能在iframe里）
  if (candidates.length === 0) {
    var iframes = document.querySelectorAll("iframe");
    for (var i = 0; i < iframes.length; i++) {
      try {
        var iframeDoc = iframes[i].contentDocument || iframes[i].contentWindow.document;
        if (iframeDoc) {
          searchInDocument(iframeDoc);
        }
      } catch (e) {
        // 跨域iframe无法访问
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates.length > 0 ? candidates[0].element : null;
}

// 功能目的：过滤非聊天输入框；实现原因：避免把话术误填到搜索框或筛选框。
function isLikelyChatInput(element) {
  if (!element || element.closest("#job-copilot-panel,#job-copilot-fill-notice,#auto-chat-notice")) {
    return false;
  }
  const hintText = [
    element.getAttribute("placeholder"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.className,
    element.id
  ].join(" ");
  if (/搜索|职位|公司|地图|筛选|期望|联系人|30天/.test(hintText)) {
    return false;
  }
  if (element.isContentEditable === false && element.tagName !== "TEXTAREA" && element.tagName !== "INPUT") {
    return false;
  }
  if (element.disabled || element.readOnly) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 20) {
    return false;
  }
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }
  // INPUT类型需要检查是否是type=text，且placeholder含有聊天相关提示
  if (element.tagName === "INPUT") {
    var type = (element.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "file" || type === "submit" || type === "button" || type === "hidden" || type === "password") {
      return false;
    }
    // 输入框的placeholder应该和聊天相关
    var placeholder = (element.getAttribute("placeholder") || "").toLowerCase();
    if (placeholder && !/聊|回复|说|输入|发送|say|reply|message|chat|send|enter/i.test(placeholder)) {
      return false;
    }
  }
  return true;
}

// 功能目的：给候选输入框排序；实现原因：BOSS 页面同时存在搜索框、消息列表和底部富文本编辑器。
function scoreChatInput(element) {
  const rect = element.getBoundingClientRect();
  const contextText = readInputContextText(element);
  let score = 0;

  if (document.activeElement === element || element.contains(document.activeElement)) {
    score += 80;
  }
  if (rect.top > window.innerHeight * 0.45) {
    score += 35;
  }
  if (rect.bottom > window.innerHeight * 0.7) {
    score += 25;
  }
  if (element.isContentEditable) {
    score += 25;
  }
  if (element.tagName === "TEXTAREA") {
    score += 20;
  }
  if (element.getAttribute("role") === "textbox") {
    score += 12;
  }
  if (/chat|im|message|reply|editor|input|textarea|dialog|conversation/i.test(contextText)) {
    score += 30;
  }
  if (/发送|发简历|换电话|换微信|Enter|Ctrl/.test(contextText)) {
    score += 25;
  }
  if (/搜索|职位|公司|筛选|地图|联系人|30天/.test(contextText)) {
    score -= 80;
  }

  return score;
}

// 功能目的：读取输入框周边上下文；实现原因：BOSS 聊天编辑器类名会变化但邻近按钮文案相对稳定。
function readInputContextText(element) {
  const parts = [element.className, element.id, element.getAttribute("placeholder"), element.getAttribute("aria-label")];
  let current = element.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1) {
    parts.push(current.className, current.id, (current.innerText || "").slice(0, 300));
    current = current.parentElement;
  }
  return parts.filter(Boolean).join(" ");
}

// 功能目的：写入聊天草稿；实现原因：BOSS 聊天框可能是富文本编辑器，直接 value 赋值不一定触发页面状态。
function writeChatDraft(input, text) {
  if (input.isContentEditable) {
    writeContentEditableDraft(input, text);
    return;
  }

  const valueSetter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
  if (valueSetter) {
    valueSetter.call(input, text);
  } else {
    input.value = text;
  }
  dispatchDraftEvents(input, text);
}

// 功能目的：写入富文本输入框；实现原因：截图中的 BOSS 对话框底部是可编辑区域而非普通 textarea。
function writeContentEditableDraft(input, text) {
  input.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  range.deleteContents();
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  const inserted = document.execCommand && document.execCommand("insertText", false, text);
  if (!inserted) {
    input.textContent = text;
    const endRange = document.createRange();
    endRange.selectNodeContents(input);
    endRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(endRange);
  }
  dispatchDraftEvents(input, text);
}

// 功能目的：通知页面输入状态变化；实现原因：Vue/React 富文本框需要 input/change 事件才能启用发送按钮。
function dispatchDraftEvents(input, text) {
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", code: "Process", keyCode: 229, which: 229 }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
  const editorContainer = input.closest(".editor-container,.chat-editor,.chat-im");
  if (editorContainer && editorContainer !== input) {
    editorContainer.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    editorContainer.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// 功能目的：返回调试定位信息；实现原因：填入失败排查时需要知道命中了哪个输入区域。
function describeChatInput(input) {
  return [input.tagName.toLowerCase(), input.id ? `#${input.id}` : "", input.className ? `.${String(input.className).trim().replace(/\s+/g, ".")}` : ""].join("");
}

// ========== 自动聊天模块 ==========

// 功能目的：启动全自动聊天；实现原因：AI 生成草稿、填入输入框并自动点击发送。
async function startAutoChat(config) {
  const requestedQueueItemId = String(config && config.queueItemId || "");
  const policy = globalThis.JobCopilotBossChatPolicy;
  const decision = policy && typeof policy.resolveAutoChatStartDecision === "function"
    ? policy.resolveAutoChatStartDecision(
      jobCopilotState.autoChatStatus,
      jobCopilotState.autoChatQueueItemId,
      jobCopilotState.autoChatStartingQueueItemId,
      requestedQueueItemId
    )
    : resolveAutoChatStartDecisionFallback(requestedQueueItemId);

  if (decision === "ignore") {
    return;
  }
  if (decision === "replace") {
    resetStaleAutoChatLocalState();
  }

  jobCopilotState.autoChatStartingQueueItemId = requestedQueueItemId;
  try {
    await runAutoChatStart(config || {});
  } finally {
    if (jobCopilotState.autoChatStartingQueueItemId === requestedQueueItemId) {
      jobCopilotState.autoChatStartingQueueItemId = "";
    }
  }
}

function resolveAutoChatStartDecisionFallback(requestedQueueItemId) {
  if (requestedQueueItemId && (
    jobCopilotState.autoChatStartingQueueItemId === requestedQueueItemId ||
    (jobCopilotState.autoChatStatus === "chatting" && jobCopilotState.autoChatQueueItemId === requestedQueueItemId)
  )) {
    return "ignore";
  }
  if (jobCopilotState.autoChatStatus === "chatting" && jobCopilotState.autoChatQueueItemId !== requestedQueueItemId) {
    return "replace";
  }
  return "start";
}

function resetStaleAutoChatLocalState() {
  if (jobCopilotState.autoChatPollingTimer) {
    window.clearInterval(jobCopilotState.autoChatPollingTimer);
    jobCopilotState.autoChatPollingTimer = null;
  }
  jobCopilotState.autoChatEnabled = false;
  jobCopilotState.autoChatStatus = "idle";
  jobCopilotState.autoChatAutoMode = false;
  jobCopilotState.autoChatQueueItemId = "";
  jobCopilotState.autoChatJobId = "";
  jobCopilotState.autoChatPendingReply = "";
  jobCopilotState.autoChatPendingRecruiterMessage = null;
  jobCopilotState.autoChatPendingHrKey = "";
}

async function runAutoChatStart(config) {

  persistAutoChatTask(config || {});
  jobCopilotState.autoChatEnabled = true;
  jobCopilotState.autoChatQueueItemId = config.queueItemId || "";
  jobCopilotState.autoChatJobId = config.jobId || "";
  jobCopilotState.autoChatResumeId = config.resumeId || "";
  jobCopilotState.autoChatMode = config.mode || "积极主动";
  jobCopilotState.autoChatAutoMode = config.autoMode === true;
  jobCopilotState.autoChatMessages = config.messages || [];
  jobCopilotState.autoChatRoundCount = config.roundCount || 0;
  jobCopilotState.autoChatMaxRounds = config.maxRounds || 10;
  jobCopilotState.autoChatSentMessages = new Set();
  jobCopilotState.autoChatSendInProgress = false;
  jobCopilotState.autoChatPendingReply = "";
  jobCopilotState.autoChatPendingRecruiterMessage = null;
  jobCopilotState.autoChatPendingHrKey = "";
  jobCopilotState.autoChatLastDraftText = "";

  showAutoChatNotice("正在阅读岗位并等待页面稳定...");

  if (completeAutoChatFromBossOpeningSentDialog()) {
    return;
  }

  var closedJobMessage = detectClosedBossJob();
  if (closedJobMessage) {
    finishAutoChatSession("skipped", closedJobMessage + "，已直接跳过并继续下一个岗位");
    return;
  }

  var interruptionMessage = detectBossInterruption();
  if (interruptionMessage) {
    finishAutoChatSession("stopped", interruptionMessage + "，岗位已保留并稍后重试");
    return;
  }

  // 功能目的：等待沟通入口可用；实现原因：BOSS 是 SPA，按钮和输入框会延迟渲染。
  const openingDraft = config.openingDraft || "";
  var commOpened = false;

  for (var retryIndex = 0; retryIndex < 3; retryIndex++) {
    if (retryIndex > 0) {
      await pacedSleep(500, 900);
    }

    closedJobMessage = detectClosedBossJob();
    if (closedJobMessage) {
      finishAutoChatSession("skipped", closedJobMessage + "，已直接跳过并继续下一个岗位");
      return;
    }

    interruptionMessage = detectBossInterruption();
    if (interruptionMessage) {
      finishAutoChatSession("stopped", interruptionMessage + "，岗位已保留并稍后重试");
      return;
    }

    if (completeAutoChatFromBossOpeningSentDialog()) {
      return;
    }

    // 先检查是否已经在聊天界面了（有输入框）
    var chatInput = findChatInput();
    if (chatInput) {
      commOpened = true;
      break;
    }

    // 尝试找并点击沟通按钮
    var commButton = findBossCommunicationButton();
    if (commButton) {
      showAutoChatNotice("找到沟通按钮，正在进入聊天... (第" + (retryIndex + 1) + "次尝试)");
      var communicationButtonText = normalizeButtonText(commButton);
      safeClick(commButton);
      if (communicationButtonText.includes("立即沟通")) {
        var continuationOpened = await clickBossContinueCommunication(6000);
        if (continuationOpened) {
          commOpened = true;
          break;
        }
      }
      await pacedSleep(900, 1500);

      if (completeAutoChatFromBossOpeningSentDialog()) {
        return;
      }

      chatInput = findChatInput();
      if (chatInput) {
        commOpened = true;
        break;
      }

      await pacedSleep(400, 700);
      chatInput = findChatInput();
      if (chatInput) {
        commOpened = true;
        break;
      }
    } else {
      // 没找到按钮，可能页面还在加载
      if (retryIndex < 2) {
        showAutoChatNotice("页面加载中，等待沟通按钮出现... (第" + (retryIndex + 1) + "次)");
      }
      if (retryIndex >= 2 && isBossChatPageWithoutActiveConversation()) {
        jobCopilotState.autoChatEnabled = false;
        showAutoChatNotice("请先在左侧选择一个非猎头联系人，再启动自动填入");
        finishAutoChatSession("stopped", "聊天会话尚未加载，岗位已保留并稍后重试");
        return;
      }
    }
  }

  if (!commOpened) {
    closedJobMessage = detectClosedBossJob();
    if (closedJobMessage) {
      finishAutoChatSession("skipped", closedJobMessage + "，已直接跳过并继续下一个岗位");
      return;
    }
    showAutoChatNotice("暂时无法进入聊天界面，岗位已保留并稍后重试");
    void notifyBackgroundByBridge("autoChatCompleted", {
      queueItemId: jobCopilotState.autoChatQueueItemId,
      status: "stopped",
      roundCount: 0
    }, 15000);
    return;
  }

  if (openingDraft && hasExistingCandidateOpeningEcho(openingDraft, config || {})) {
    jobCopilotState.autoChatStatus = "chatting";
    jobCopilotState.autoChatRoundCount = Math.max(jobCopilotState.autoChatRoundCount, 1);
    finishAutoChatSession("completed", "检测到 BOSS 已发出招呼，继续投递下一个岗位");
    return;
  }

  if (isActiveConversationHeadhunter()) {
    finishAutoChatSession("rejected", "当前会话疑似猎头，已按筛选策略排除");
    showAutoChatNotice("当前会话疑似猎头，已按筛选策略排除");
    return;
  }

  jobCopilotState.autoChatStatus = "chatting";

  if (openingDraft && jobCopilotState.autoChatRoundCount === 0) {
    await fillOpeningAutoChatDraft(openingDraft);
  } else if (jobCopilotState.autoChatAutoMode) {
    finishAutoChatSession("stopped", "开场白尚未准备完成，岗位已保留并稍后重试");
  } else {
    showAutoChatNotice("已进入聊天界面，开始监听 HR 新消息");
  }

  if (!jobCopilotState.autoChatEnabled || jobCopilotState.autoChatStatus !== "chatting") {
    return;
  }

  startAutoChatPolling();
}

// BOSS 首次点击“立即沟通”后还可能出现“继续沟通”；只有完成第二次点击才会渲染聊天输入框。
async function clickBossContinueCommunication(timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (findChatInput()) {
      return true;
    }
    const continuationButton = findBossCommunicationButton();
    const continuationText = continuationButton ? normalizeButtonText(continuationButton) : "";
    if (continuationButton && continuationText.includes("继续沟通")) {
      showAutoChatNotice("正在点击继续沟通并打开聊天框...");
      safeClick(continuationButton);
      await pacedSleep(700, 1100);
      return !!findChatInput();
    }
    await pacedSleep(300, 500);
  }
  return false;
}

// 功能目的：识别 BOSS 点击沟通后自动发出的候选人招呼；实现原因：这种情况无需再填入第二条消息。
function hasExistingCandidateOpeningEcho(openingDraft, config) {
  const conversation = document.querySelector(".chat-conversation");
  if (!conversation || !isVisibleElement(conversation)) {
    return false;
  }

  const conversationText = normalizeComparableText(conversation.innerText || "");
  if (!conversationText) {
    return false;
  }
  if (!isConversationLikelyForAutoChatTask(conversationText, config || {})) {
    return false;
  }

  const defaultGreeting = "您好，对贵公司很感兴趣，希望能和您聊聊";
  return [openingDraft, defaultGreeting].some(function(text) {
    const key = normalizeComparableText(text).slice(0, 32);
    return key.length >= 8 && conversationText.includes(key);
  });
}

// 功能目的：识别并处理 BOSS 的“订阅回复消息”弹窗；实现原因：出现“已发送”说明平台招呼已送达，不能继续等待聊天输入框。
function completeAutoChatFromBossOpeningSentDialog() {
  const dialog = findBossOpeningSentDialog();
  if (!dialog) {
    return false;
  }

  closeBossOpeningSentDialog(dialog);
  jobCopilotState.autoChatStatus = "chatting";
  jobCopilotState.autoChatRoundCount = Math.max(jobCopilotState.autoChatRoundCount, 1);
  finishAutoChatSession("completed", "BOSS 已自动发送招呼，继续投递下一个岗位");
  return true;
}

function findBossOpeningSentDialog() {
  const policy = globalThis.JobCopilotBossChatPolicy;
  const isSentDialogText = policy && typeof policy.isOpeningSentDialogText === "function"
    ? policy.isOpeningSentDialogText
    : function(value) {
      const text = String(value || "").replace(/\s+/g, "");
      return text.includes("已发送") && (text.includes("订阅回复消息") || /微信.*扫码.*订阅/.test(text));
    };
  const candidates = [];
  const seenElements = new Set();
  const selectors = [
    "[role='dialog']",
    ".dialog-wrap",
    ".dialog-container",
    ".dialog-content",
    ".modal-content",
    "[class*='dialog']",
    "[class*='modal']",
    "[class*='popup']"
  ];

  selectors.forEach(function(selector) {
    document.querySelectorAll(selector).forEach(function(element) {
      if (seenElements.has(element) || !isVisibleElement(element)) {
        return;
      }
      seenElements.add(element);
      const text = String(element.innerText || element.textContent || "").trim();
      if (text.length <= 1200 && isSentDialogText(text)) {
        candidates.push({ element: element, textLength: text.length });
      }
    });
  });

  candidates.sort(function(left, right) {
    return left.textLength - right.textLength;
  });
  return candidates.length > 0 ? candidates[0].element : null;
}

function closeBossOpeningSentDialog(dialog) {
  const candidates = Array.from(dialog.querySelectorAll(
    "button,a,[role='button'],[aria-label*='关闭'],[title*='关闭'],[class*='close'],i,span"
  )).filter(function(element) {
    if (!isVisibleElement(element)) {
      return false;
    }
    const text = normalizeButtonText(element);
    const attributes = [element.className, element.getAttribute("aria-label"), element.getAttribute("title")]
      .filter(Boolean).join(" ");
    return /^(关闭|×|✕|✖)$/.test(text) || /close|关闭/i.test(attributes);
  });
  if (candidates.length > 0) {
    safeClick(normalizeClickableElement(candidates[0]));
  }
}

// 功能目的：避免把旧会话误认为当前队列项；实现原因：聊天页会默认停留在最近联系人。
function isConversationLikelyForAutoChatTask(conversationText, config) {
  const title = normalizeComparableText(config.title || "");
  const company = normalizeComparableText(config.company || "");
  if (!title && !company) {
    return true;
  }
  if (company && conversationText.includes(company)) {
    return true;
  }
  if (title && conversationText.includes(title)) {
    return true;
  }
  if (title.length >= 10 && conversationText.includes(title.slice(0, 10))) {
    return true;
  }
  return false;
}

// 功能目的：停止聊天助手；实现原因：用户可随时终止草稿生成。
function stopAutoChat() {
  jobCopilotState.autoChatEnabled = false;
  jobCopilotState.autoChatStatus = "stopped";
  jobCopilotState.autoChatAutoMode = false;
  if (jobCopilotState.autoChatPollingTimer) {
    window.clearInterval(jobCopilotState.autoChatPollingTimer);
    jobCopilotState.autoChatPollingTimer = null;
  }
  showAutoChatNotice("自动聊天已停止");

  // 通知后端
  if (jobCopilotState.autoChatQueueItemId) {
    requestLocalJSON("/api/chat/auto/status", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: jobCopilotState.autoChatQueueItemId,
        status: "stopped"
      })
    }).catch(function() {});
  }
}

// 功能目的：启动轮询监听HR新消息；实现原因：需要持续检测页面上的HR回复。
function startAutoChatPolling() {
  if (jobCopilotState.autoChatPollingTimer) {
    window.clearInterval(jobCopilotState.autoChatPollingTimer);
  }

  jobCopilotState.autoChatPollingTimer = window.setInterval(checkForHrNewMessage, 5000);
}

// 功能目的：识别未选中会话的聊天页；实现原因：没有右侧输入框时无法填入草稿。
function isBossChatPageWithoutActiveConversation() {
  if (!location.href.includes("/web/geek/chat")) {
    return false;
  }
  if (findChatInput()) {
    return false;
  }
  return /与您进行过沟通的 Boss 都会在左侧列表中显示/.test(document.body.innerText || "");
}

// 功能目的：识别猎头会话；实现原因：用户明确要求猎头会话不处理。
function isActiveConversationHeadhunter() {
  const conversation = document.querySelector(".chat-conversation");
  const text = conversation ? (conversation.innerText || "").slice(0, 600) : "";
  return /猎头|猎头顾问/i.test(text);
}

// 功能目的：填入开场白草稿；实现原因：全自动模式发出首条后必须释放队列继续处理下一个岗位。
async function fillOpeningAutoChatDraft(openingDraft) {
  await pacedSleep(500, 900);
  const input = await waitForChatInput(5000);
  if (!input) {
    showAutoChatNotice("等待聊天输入框超时，无法填入开场白");
    if (jobCopilotState.autoChatAutoMode) {
      finishAutoChatSession("stopped", "聊天输入框暂未加载，岗位已保留并稍后重试");
    }
    return;
  }

  const existingText = readChatInputText(input).trim();
  if (existingText && !chatInputContainsDraft(input, openingDraft)) {
    jobCopilotState.autoChatRoundCount = Math.max(jobCopilotState.autoChatRoundCount, 1);
    jobCopilotState.autoChatLastDraftText = existingText;
    jobCopilotState.autoChatSentMessages.add(normalizeAutoChatMessageKey(existingText).slice(0, 60));
    jobCopilotState.autoChatMessages.push(
      { role: "candidate", content: existingText, createdAt: new Date().toISOString() }
    );
    showAutoChatNotice(jobCopilotState.autoChatAutoMode
      ? "输入框已有内容，准备继续下一个岗位"
      : "输入框已有内容，已保留现有草稿并开始监听 HR 回复");
    primeAutoChatHrBaseline();
    if (jobCopilotState.autoChatAutoMode) {
      finishAutoChatSession("stopped", "输入框已有内容，已保留现场并稍后重试");
    }
    return;
  }

  const fillResult = fillDraft(openingDraft);
  if (!fillResult.ok) {
    showAutoChatNotice("填入开场白失败: " + (fillResult.error || "未知"));
    if (jobCopilotState.autoChatAutoMode) {
      finishAutoChatSession("stopped", "填入开场白暂时失败，岗位已保留并稍后重试");
    }
    return;
  }

  jobCopilotState.autoChatRoundCount = 1;
  jobCopilotState.autoChatLastDraftText = openingDraft;
  jobCopilotState.autoChatSentMessages.add(normalizeAutoChatMessageKey(openingDraft).slice(0, 60));
  jobCopilotState.autoChatMessages.push(
    { role: "candidate", content: openingDraft, createdAt: new Date().toISOString() }
  );
  primeAutoChatHrBaseline();

  await pacedSleep(700, 1200);
  const openingSendKey = makeDraftSendKey("auto-opening", jobCopilotState.autoChatQueueItemId || jobCopilotState.autoChatJobId, openingDraft);
  var sent = sendDraftOnce(openingSendKey, "开场白");
  if (sent) {
    showAutoChatNotice(jobCopilotState.autoChatAutoMode
      ? "开场白已自动发送，继续下一个岗位"
      : "开场白已自动发送，正在监听 HR 回复...");
  } else {
    showAutoChatNotice("开场白已处理，本条不会重复发送");
  }
  if (jobCopilotState.autoChatAutoMode) {
    await pacedSleep(800, 1400);
    finishAutoChatSession("completed", "开场白已处理，继续投递下一个岗位");
  }
}

// 功能目的：记录进入聊天时已有的 HR 消息；实现原因：避免对历史消息重复生成回复。
function primeAutoChatHrBaseline() {
  const hrMessages = extractHrMessagesFromPage();
  if (hrMessages.length === 0) {
    jobCopilotState.autoChatLastHrMessage = "";
    return;
  }
  const latestHrMsg = hrMessages[hrMessages.length - 1];
  jobCopilotState.autoChatLastHrMessage = normalizeAutoChatMessageKey(latestHrMsg.content);
}

// 功能目的：生成稳定的消息去重键；实现原因：BOSS 页面会混入空白和状态文本。
function normalizeAutoChatMessageKey(content) {
  return normalizeComparableText(String(content || "")).slice(0, 80);
}

// 功能目的：显示自动聊天状态通知；实现原因：用户需要知道自动聊天的进度。
function showAutoChatNotice(message) {
  var notice = document.getElementById("auto-chat-notice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "auto-chat-notice";
    notice.style.cssText = "position:fixed;right:24px;top:24px;z-index:2147483647;max-width:400px;padding:12px 16px;border-radius:8px;background:#0f766e;color:#fff;font-size:14px;font-weight:600;box-shadow:0 8px 30px rgba(15,23,42,.3);cursor:pointer";
    notice.title = "点击查看对话日志";
    notice.onclick = function() {
      showAutoChatLogPanel();
    };
    document.body.appendChild(notice);
  }
  notice.textContent = message + " (点击查看日志)";
  notice.style.display = "block";

  window.clearTimeout(notice._timeout);
  notice._timeout = window.setTimeout(function() {
    notice.style.display = "none";
  }, 8000);
}

// 功能目的：显示自动聊天对话日志面板；实现原因：用户需要看到AI的决策过程和每轮对话。
function showAutoChatLogPanel() {
  var panel = document.getElementById("auto-chat-log-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "auto-chat-log-panel";
    panel.style.cssText = "position:fixed;right:24px;bottom:80px;z-index:2147483646;width:380px;max-height:400px;overflow-y:auto;background:rgba(15,23,42,.92);color:#e2e8f0;border-radius:8px;padding:12px;font-size:12px;font-family:monospace;box-shadow:0 8px 30px rgba(15,23,42,.4);display:none";
    
    // 标题栏
    var header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.1)";
    header.innerHTML = '<span style="color:#0f766e;font-weight:700">AI 对话日志</span>' +
      '<button id="auto-chat-log-close" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px">×</button>';
    panel.appendChild(header);
    
    // 日志内容区
    var content = document.createElement("div");
    content.id = "auto-chat-log-content";
    panel.appendChild(content);
    
    document.body.appendChild(panel);
    
    document.getElementById("auto-chat-log-close").onclick = function() {
      panel.style.display = "none";
    };
  }
  panel.style.display = "block";
  
  // 刷新日志内容
  var contentEl = document.getElementById("auto-chat-log-content");
  if (contentEl && jobCopilotState._autoChatLog) {
    var html = "";
    var logs = jobCopilotState._autoChatLog.slice(-20); // 最近20条
    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      var color = "#94a3b8";
      if (log.action === "DETECT") color = "#38bdf8";
      else if (log.action === "REPLY") color = "#4ade80";
      else if (log.action === "SEND") color = "#fbbf24";
      else if (log.action === "ERROR") color = "#f87171";
      else if (log.action === "SKIP") color = "#94a3b8";
      
      html += '<div style="margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,.04);border-radius:4px">' +
        '<span style="color:' + color + ';font-weight:600">#' + log.round + " " + log.action + '</span> ' +
        '<span style="color:#64748b">' + (log.time || "").slice(11, 19) + '</span><br>' +
        '<span style="color:#cbd5e1">HR: ' + escapeHtml(log.hrMessage || "").slice(0, 60) + '</span><br>';
      if (log.candidateReply) {
        html += '<span style="color:#86efac">回复: ' + escapeHtml(log.candidateReply || "").slice(0, 60) + '</span>';
      }
      html += '</div>';
    }
    if (logs.length === 0) {
      html = '<div style="color:#64748b;text-align:center;padding:12px">暂无对话日志</div>';
    }
    contentEl.innerHTML = html;
  }
}

function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise(function(resolve) {
    window.setTimeout(resolve, ms);
  });
}

function pacedSleep(minDelayMs, maxDelayMs) {
  var minDelay = Math.max(0, Math.floor(Number(minDelayMs) || 0));
  var maxDelay = Math.max(minDelay, Math.floor(Number(maxDelayMs) || minDelay));
  return sleep(minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1)));
}

function detectBossInterruption() {
  var bodyText = String(document.body && document.body.innerText || "").slice(0, 6000);
  if (/安全验证|请完成验证|滑动验证|验证码|访问过于频繁|异常访问/.test(bodyText)) {
    return "检测到平台验证或访问限制";
  }
  return "";
}

// 功能目的：识别 BOSS 明确停止招聘的职位；实现原因：已关闭职位无法进入聊天，不应作为临时加载失败反复重试。
function detectClosedBossJob() {
  if (!String(location.pathname || "").includes("/job_detail/")) {
    return "";
  }

  var policy = globalThis.JobCopilotBossSearchPolicy;
  if (!policy || typeof policy.isClosedJobStatusText !== "function") {
    return "";
  }

  var statusSelectors = [
    ".job-status",
    "[class*='job-status']",
    "[class*='jobStatus']",
    "[class*='position-status']"
  ];
  for (var selectorIndex = 0; selectorIndex < statusSelectors.length; selectorIndex++) {
    var statusElements = document.querySelectorAll(statusSelectors[selectorIndex]);
    for (var elementIndex = 0; elementIndex < statusElements.length; elementIndex++) {
      var statusElement = statusElements[elementIndex];
      var statusText = String(statusElement.innerText || statusElement.textContent || "").trim();
      if (isVisibleElement(statusElement) && policy.isClosedJobStatusText(statusText)) {
        return statusText || "职位已关闭";
      }
    }
  }

  var pageLines = String(document.body && document.body.innerText || "")
    .split(/\r?\n/)
    .slice(0, 40);
  for (var lineIndex = 0; lineIndex < pageLines.length; lineIndex++) {
    var pageLine = String(pageLines[lineIndex] || "").trim();
    if (policy.isClosedJobStatusText(pageLine)) {
      return pageLine || "职位已关闭";
    }
  }
  return "";
}

// 功能目的：从 URL 检测是否需要启动聊天助手；实现原因：Web 控制台和 background 通过 URL 参数传递填入指令。
function checkAutoChatFromURL() {
  try {
    var hash = String(location.hash || "").replace(/^#/, "");
    var search = String(location.search || "").replace(/^\?/, "");
    var allParams = (search + "&" + hash);
    var params = {};
    allParams.split("&").forEach(function(pair) {
      var parts = pair.split("=");
      if (parts.length === 2) {
        try {
          params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1]);
        } catch (e) {
          params[parts[0]] = parts[1];
        }
      }
    });

    if (params.autoChat !== "1") {
      return;
    }

    var queueItemId = params.queueItemId || "";
    var jobId = params.jobId || "";
    var openingDraft = params.draft || "";
    var mode = params.mode || "积极主动";
    var title = params.title || "";
    var company = params.company || "";

    if (!jobId || !queueItemId) {
      return;
    }

    persistAutoChatTask({
      queueItemId: queueItemId,
      jobId: jobId,
      mode: mode,
      openingDraft: openingDraft,
      title: title,
      company: company,
      autoMode: true
    });

    showAutoChatNotice("检测到自动聊天指令，等待页面加载...");

    // 功能目的：多次重试启动聊天助手；实现原因：页面加载完成时间不可预测。
    var retryCount = 0;
    var maxRetries = 8;
    function tryStart() {
      retryCount++;
      // 先检查页面是否已经加载了足够的内容
      var bodyText = (document.body ? document.body.innerText || "" : "");
      if (bodyText.length < 100 && retryCount <= maxRetries) {
        // 页面还没加载完，继续等
        showAutoChatNotice("页面加载中... (" + retryCount + "/" + maxRetries + ")");
        window.setTimeout(tryStart, 3000);
        return;
      }

      showAutoChatNotice("页面已加载，启动聊天助手...");
      startAutoChat({
        queueItemId: queueItemId,
        jobId: jobId,
        resumeId: "",
        mode: mode,
        messages: [],
        roundCount: 0,
        maxRounds: jobCopilotState.autoChatMaxRounds || 10,
        openingDraft: openingDraft,
        title: title,
        company: company,
        autoMode: true
      }).catch(function(err) {
        showAutoChatNotice("自动聊天启动失败: " + (err.message || "未知错误"));
      });
    }

    // 页面脚本已在 document_idle 执行，短暂等待即可开始；内部仍会重试异步渲染的沟通按钮。
    window.setTimeout(tryStart, 1000);
  } catch (e) {
    // 忽略URL解析错误
    console.log("[JobCopilot] URL解析失败: " + (e.message || ""));
  }
}

// ========== 自动翻页扫描模块 ==========

// 功能目的：把系统中的岗位、城市和薪资条件同步到 BOSS 搜索页；实现原因：只在本地过滤会抓取大量无关岗位。
async function applyBossSearchFilters(config) {
  if (!isBossJobsPage()) {
    return { ok: false, error: "当前不是 BOSS 职位搜索页" };
  }

  var keyword = String(config && config.keyword || "").trim();
  var searchInput = document.querySelector(".job-search-form input[placeholder*='搜索'], .job-search-form input.input");
  var keywordFilled = false;
  if (searchInput && keyword && String(searchInput.value || "").trim() !== keyword) {
    setBossSearchInputValue(searchInput, keyword);
    keywordFilled = true;
  }

  var positionApplied = await applyBossPositionFilter(config || {});
  var jobTypeApplied = await applyBossSimpleFilter(
    "jobType",
    config && config.jobTypeCode,
    config && config.jobTypeLabel
  );

  var salaryBand = JobCopilotBossSearchPolicy.resolveSalaryBand(
    config && config.minSalaryK,
    config && config.maxSalaryK
  );
  var salaryApplied = false;
  if (salaryBand) {
    var salaryFilter = findBossSalaryFilter();
    if (salaryFilter && !isBossSalaryBandSelected(salaryFilter, salaryBand)) {
      var beforeSignature = readBossJobListSignature();
      var currentSelect = salaryFilter.querySelector(".current-select");
      var salaryOption = findBossSalaryOption(salaryFilter, salaryBand);
      if (currentSelect && salaryOption) {
        clickBossFilterElement(currentSelect);
        await sleep(80);
        clickBossFilterElement(salaryOption);
        salaryApplied = true;
        await waitForBossJobListUpdate(beforeSignature, 5000);
      }
    }
  }

  return {
    ok: true,
    keywordFilled: keywordFilled,
    city: readFirstText([".filter-condition .cur-city-label"], 40),
    position: String(config && config.positionLabel || ""),
    positionApplied: positionApplied,
    jobType: String(config && config.jobTypeLabel || ""),
    jobTypeApplied: jobTypeApplied,
    salaryBand: salaryBand ? salaryBand.label : "",
    salaryApplied: salaryApplied
  };
}

async function applyBossPositionFilter(config) {
  var positionCode = String(config && config.positionCode || "").trim();
  if (!/^\d{6}$/.test(positionCode)) {
    return false;
  }

  var container = document.querySelector(".condition-position-select");
  if (!container || hasBossFilterOptionSelected(container, "sel-position-" + positionCode)) {
    return false;
  }

  var beforeSignature = readBossJobListSignature();
  clickBossFilterElement(container.querySelector(".current-select"));
  await sleep(60);
  var category = findBossFilterElementByText(
    container.querySelectorAll(".filter-select-dropdown > ul > li"),
    config && config.positionCategory
  );
  if (category) {
    category.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    category.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(80);
  }

  var option = container.querySelector("[ka='sel-position-" + positionCode + "']");
  if (!option) {
    return false;
  }
  clickBossFilterElement(option);
  await waitForBossJobListUpdate(beforeSignature, 5000);
  return true;
}

async function applyBossSimpleFilter(filterName, rawCode, expectedLabel) {
  var filterCode = String(rawCode || "").trim();
  if (!/^\d+$/.test(filterCode)) {
    return false;
  }

  var optionSelector = "[ka='sel-job-rec-" + filterName + "-" + filterCode + "']";
  var option = document.querySelector(optionSelector);
  var container = option && option.closest(".condition-filter-select");
  if (!option || !container || hasBossFilterOptionSelected(container, "sel-job-rec-" + filterName + "-" + filterCode)) {
    return false;
  }

  var optionText = String(option.innerText || option.textContent || "").replace(/\s+/g, "").trim();
  var normalizedExpectedLabel = String(expectedLabel || "").replace(/\s+/g, "").trim();
  if (normalizedExpectedLabel && optionText !== normalizedExpectedLabel) {
    return false;
  }

  var beforeSignature = readBossJobListSignature();
  clickBossFilterElement(container.querySelector(".current-select"));
  await sleep(60);
  clickBossFilterElement(option);
  await waitForBossJobListUpdate(beforeSignature, 5000);
  return true;
}

function clickBossFilterElement(element) {
  if (element && typeof element.click === "function") {
    element.click();
  }
}

function hasBossFilterOptionSelected(container, optionKa) {
  var option = container && container.querySelector("[ka='" + optionKa + "']");
  return !!(option && /(^|\s)(active|selected|cur)(\s|$)/.test(String(option.className || "")));
}

function findBossFilterElementByText(elements, expectedText) {
  var normalizedExpectedText = String(expectedText || "").replace(/\s+/g, "").trim();
  if (!normalizedExpectedText) {
    return null;
  }
  for (var index = 0; index < elements.length; index++) {
    var elementText = String(elements[index].innerText || elements[index].textContent || "").replace(/\s+/g, "").trim();
    if (elementText === normalizedExpectedText) {
      return elements[index];
    }
  }
  return null;
}

function setBossSearchInputValue(input, value) {
  var valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (valueSetter && typeof valueSetter.set === "function") {
    valueSetter.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findBossSalaryFilter() {
  var filterControls = document.querySelectorAll(".filter-condition .condition-filter-select");
  for (var index = 0; index < filterControls.length; index++) {
    var filterControl = filterControls[index];
    if (filterControl.querySelector("[ka*='salary-']")) {
      return filterControl;
    }
  }
  return null;
}

function findBossSalaryOption(filterControl, salaryBand) {
  var options = filterControl.querySelectorAll("[ka*='salary-']");
  for (var index = 0; index < options.length; index++) {
    var option = options[index];
    var optionText = String(option.innerText || option.textContent || "").replace(/\s+/g, "").trim();
    var optionCode = String(option.getAttribute("ka") || "").match(/salary-(\d+)/);
    if (optionText.includes(salaryBand.label.replace(/\s+/g, "")) || optionCode && optionCode[1] === salaryBand.code) {
      return option;
    }
  }
  return null;
}

function isBossSalaryBandSelected(filterControl, salaryBand) {
  var selectedText = String((filterControl.querySelector(".current-select") || {}).innerText || "")
    .replace(/\s+/g, "")
    .trim();
  if (selectedText.includes(salaryBand.label.replace(/\s+/g, ""))) {
    return true;
  }
  var selectedOption = filterControl.querySelector("[ka*='salary-'].active, [ka*='salary-'].selected, [ka*='salary-'].cur");
  var selectedCode = selectedOption && String(selectedOption.getAttribute("ka") || "").match(/salary-(\d+)/);
  return !!(selectedCode && selectedCode[1] === salaryBand.code);
}

function readBossJobListSignature() {
  var jobKeys = readBossVisibleJobURLs();
  return location.href + "|" + jobKeys.length + "|" + jobKeys.slice(-8).join("|");
}

function readBossVisibleJobURLs() {
  var seenURLs = new Set();
  var jobURLs = [];
  document.querySelectorAll("a.job-name[href], a[href*='/job_detail/']").forEach(function(link) {
    var jobURL = String(link.href || link.getAttribute("href") || "").trim();
    if (!jobURL || seenURLs.has(jobURL)) {
      return;
    }
    seenURLs.add(jobURL);
    jobURLs.push(jobURL);
  });
  return jobURLs;
}

async function waitForBossJobListUpdate(previousSignature, timeoutMs) {
  var deadline = Date.now() + Math.max(500, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (readBossJobListSignature() !== previousSignature && readBossVisibleJobURLs().length > 0) {
      return true;
    }
    await sleep(120);
  }
  return false;
}

// 功能目的：一键全自动翻页扫描；实现原因：background触发完整翻页流程，不逐批同步，所有岗位一次性返回。
async function oneClickAutoScroll(maxPages, scrollDelay, maxJobs, stopAfterFirstNewBatch) {
  var allJobs = [];
  var seenUrls = new Set();
  var pageCount = 0;
  var jobLimit = Math.max(1, Number(maxJobs) || 500);

  showAutoChatNotice("一键扫描：开始抓取岗位...");

  // 先用URL去重获取首屏已有URL（从已入库数据避免重复）
  try {
    var existingPayload = await requestLocalJSON("/api/jobs?limit=500", { method: "GET" });
    if (existingPayload && existingPayload.jobs) {
      for (var i = 0; i < existingPayload.jobs.length; i++) {
        if (existingPayload.jobs[i].url) {
          seenUrls.add(existingPayload.jobs[i].url);
        }
      }
    }
  } catch (e) {}

  var initialDeadline = Date.now() + 5000;
  while (readBossVisibleJobURLs().length === 0 && Date.now() < initialDeadline) {
    await sleep(120);
  }

  while (pageCount < maxPages && allJobs.length < jobLimit) {
    // 提取当前可见岗位
    var visibleJobs = extractVisibleJobsFromPage();
    var newJobs = [];
    for (var i = 0; i < visibleJobs.length; i++) {
      var job = visibleJobs[i];
      var jobUrl = job.url || "";
      if (jobUrl && !seenUrls.has(jobUrl)) {
        seenUrls.add(jobUrl);
        if (allJobs.length + newJobs.length < jobLimit) {
          newJobs.push(job);
        }
      }
    }

    newJobs = JobCopilotBossSearchPolicy.selectNextJobBatch(newJobs, stopAfterFirstNewBatch);
    if (newJobs.length > 0) {
      allJobs = allJobs.concat(newJobs);
    }
    showAutoChatNotice("一键扫描：已扫描第" + (pageCount + 1) + "页，新增 " + allJobs.length + " 个岗位");

    pageCount++;

    if (JobCopilotBossSearchPolicy.shouldStopAfterNewBatch(stopAfterFirstNewBatch, newJobs.length)) {
      showAutoChatNotice("发现新岗位，立即进入投递");
      break;
    }

    // 尝试翻到下一页
    if (pageCount >= maxPages) break;

    await pacedSleep(Math.max(800, scrollDelay), Math.max(1500, scrollDelay * 2));
    var currentSignature = readBossJobListSignature();
    var hasNext = await scrollToNextPage(scrollDelay, pageCount, seenUrls, currentSignature);
    if (!hasNext) {
      showAutoChatNotice("没有更多页面了，扫描结束");
      break;
    }
  }

  showAutoChatNotice("一键扫描完成：共 " + allJobs.length + " 个岗位，" + pageCount + " 页");

  return {
    jobs: allJobs,
    pagesScrolled: pageCount
  };
}

// 功能目的：滚动到下一页；实现原因：BOSS页面可能是无限滚动或分页按钮，需要同时支持。
async function scrollToNextPage(scrollDelay, currentPageNumber, seenUrls, currentSignature) {
  // 策略1：查找"下一页"分页按钮
  var nextButtons = document.querySelectorAll(".options-pages a, .page .next, [class*='pagination'] .next, .pager .next, button.next, [ka*='page-next'], [aria-label*='下一页']");
  for (var i = 0; i < nextButtons.length; i++) {
    var btn = nextButtons[i];
    if (!isVisibleElement(btn)) continue;
    var text = (btn.innerText || "").trim();
    if (text.includes("下一页") || text.includes(">") || text === "»") {
      // 检查是否禁用
      if (btn.classList.contains("disabled") || btn.getAttribute("disabled") || btn.parentElement && btn.parentElement.classList.contains("disabled")) {
        return false;
      }
      showAutoChatNotice("点击翻到下一页...");
      safeClick(btn);
      return waitForBossJobListUpdate(currentSignature, Math.max(3000, scrollDelay * 8));
    }
  }

  // 策略2：查找页码链接
  var pageLinks = document.querySelectorAll(".options-pages a.page, [class*='pagination'] a, .pager a");
  var currentPageNum = Number(currentPageNumber) || 1;
  for (var j = 0; j < pageLinks.length; j++) {
    var link = pageLinks[j];
    var linkText = (link.innerText || "").trim();
    var pageNum = parseInt(linkText, 10);
    if (pageNum === currentPageNum + 1) {
      if (!link.classList.contains("disabled") && !link.classList.contains("cur")) {
        showAutoChatNotice("点击跳转第" + pageNum + "页...");
        safeClick(link);
        return waitForBossJobListUpdate(currentSignature, Math.max(3000, scrollDelay * 8));
      }
    }
  }

  // 策略3：无限滚动 - 滚动到底部
  var oldHeight = document.documentElement.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);

  // 自适应等待新岗位出现，页面响应快时立即继续，不再每页重复固定等待。
  var waited = 0;
  var waitLimit = Math.max(3000, scrollDelay * 8);
  while (waited < waitLimit) {
    await sleep(120);
    waited += 120;
    var loadedJobURLs = readBossVisibleJobURLs();
    var hasNewJob = loadedJobURLs.some(function(jobURL) {
      return jobURL && seenUrls && !seenUrls.has(jobURL);
    });
    if (hasNewJob || readBossJobListSignature() !== currentSignature) {
      return true;
    }
    if (waited % 600 === 0 || document.documentElement.scrollHeight > oldHeight + 200) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      oldHeight = document.documentElement.scrollHeight;
    }
  }

  return false;
}

// 功能目的：自动滚动页面并逐批同步岗位；实现原因：全自动模式下需要抓取超过首屏的岗位。
async function autoScrollAndSync(maxScrolls, scrollDelay) {
  var allJobs = [];
  var seenUrls = new Set();
  var scrollCount = 0;

  showAutoChatNotice("全自动模式：开始扫描岗位...");

  while (scrollCount < maxScrolls) {
    // 提取当前可见岗位
    var visibleJobs = extractVisibleJobsFromPage();
    var newJobs = [];
    for (var i = 0; i < visibleJobs.length; i++) {
      var job = visibleJobs[i];
      if (!seenUrls.has(job.url)) {
        seenUrls.add(job.url);
        newJobs.push(job);
      }
    }

    if (newJobs.length > 0) {
      allJobs = allJobs.concat(newJobs);
      showAutoChatNotice("全自动扫描：已发现 " + allJobs.length + " 个岗位（第" + (scrollCount + 1) + "页）");

      // 每批同步到后端
      try {
        await requestLocalJSON("/api/jobs/visible/analyze", {
          method: "POST",
          body: JSON.stringify({
            jobs: newJobs,
            candidateSkills: [],
            minScore: 0
          })
        });
      } catch (e) {}
    }

    // 滚动到页面底部
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(scrollDelay);

    // 检查是否还有更多内容
    var newVisibleJobs = extractVisibleJobsFromPage();
    var hasNewContent = newVisibleJobs.some(function(j) { return !seenUrls.has(j.url); });

    if (!hasNewContent && scrollCount > 1) {
      // 连续两次没有新内容，停止滚动
      break;
    }

    scrollCount++;
  }

  showAutoChatNotice("全自动扫描完成：共发现 " + allJobs.length + " 个岗位");

  // 通知 background 扫描完成
  void notifyBackgroundByBridge("autoSyncCompleted", {
    jobCount: allJobs.length,
    jobs: allJobs
  }, 15000);

  return {
    jobCount: allJobs.length,
    jobs: allJobs
  };
}

// ========== 全自动模式完成通知 ==========

// 重写 stopAutoChat，在全自动模式下通知 background
var originalStopAutoChat = stopAutoChat;
stopAutoChat = function() {
  var wasChatting = jobCopilotState.autoChatStatus === "chatting";
  var queueItemId = jobCopilotState.autoChatQueueItemId;
  var finalStatus = "stopped";

  originalStopAutoChat();

  // 全自动模式下通知 background
  if (wasChatting && queueItemId) {
    void notifyBackgroundByBridge("autoChatCompleted", {
      queueItemId: queueItemId,
      status: finalStatus,
      roundCount: jobCopilotState.autoChatRoundCount
    }, 15000);
  }
};

// 功能目的：恢复已发送草稿锁；实现原因：BOSS 页面刷新或 SPA 重绘后仍不能重复发送同一内容。
function loadSentDraftKeys() {
  loadSentDraftKeysFromStorage(window.localStorage);
  loadSentDraftKeysFromStorage(window.sessionStorage);
}

// 功能目的：写入已发送草稿锁；实现原因：同一 HR 会话重复轮询必须跨刷新保持幂等。
function saveSentDraftKeys() {
  try {
    const serializedKeys = JSON.stringify(Array.from(jobCopilotState.sentDraftKeys).slice(-500));
    safeLocalStorageSet("jobCopilotSentDraftKeys", serializedKeys);
    safeSessionStorageSet("jobCopilotSentDraftKeys", serializedKeys);
  } catch (e) {}
}

// 功能目的：从指定存储恢复发送锁；实现原因：兼容旧版 sessionStorage 和新版 localStorage。
function loadSentDraftKeysFromStorage(storage) {
  try {
    if (!storage) {
      return;
    }
    const rawValue = storage.getItem("jobCopilotSentDraftKeys") || "[]";
    JSON.parse(rawValue).forEach(function(key) {
      if (key) {
        jobCopilotState.sentDraftKeys.add(key);
      }
    });
  } catch (e) {}
}

// 功能目的：生成会话级发送锁；实现原因：HR 消息 key 变化时同一会话同一话术仍只能发送一次。
function makeConversationDraftSendKey(sendKey, draftText) {
  return [
    "conversation-draft",
    resolveConversationSendScope(sendKey),
    hashDraftText(draftText)
  ].join("|");
}

// 功能目的：定位当前发送会话；实现原因：同一句话可以发给不同岗位，但不能在同一 HR 会话重复发。
function resolveConversationSendScope(identifier) {
  const taskId = jobCopilotState.autoChatQueueItemId ||
    sessionStorage.getItem("jobCopilotTask") ||
    readFillTaskQueueItemIDFromHash();
  if (taskId) {
    return "task:" + String(taskId).slice(0, 120);
  }

  const identityText = readActiveConversationIdentityText();
  if (identityText) {
    return "chat:" + hashDraftText(identityText);
  }

  return "url:" + hashDraftText([
    location.origin,
    location.pathname,
    String(identifier || location.href).slice(0, 160)
  ].join("|"));
}

// 功能目的：读取当前聊天对象标识；实现原因：没有队列任务时仍要尽量识别同一 HR 会话。
function readActiveConversationIdentityText() {
  const selectors = [
    ".chat-header",
    ".im-chat-header",
    ".chat-user",
    ".chat-title",
    ".boss-info",
    ".conversation-list .active",
    ".chat-list .active",
    "[class*='conversation'] [class*='active']",
    "[class*='selected']"
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (typeof isVisibleElement === "function" && !isVisibleElement(element)) {
        continue;
      }
      const identityText = normalizeConversationIdentityText(element.innerText || "");
      if (identityText) {
        return identityText;
      }
    }
  }
  return "";
}

// 功能目的：压缩会话标识文本；实现原因：联系人列表会混入时间、未读数和按钮文案。
function normalizeConversationIdentityText(rawText) {
  const lines = String(rawText || "")
    .split(/\n+/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean)
    .filter(function(line) {
      return !/搜索|全部|未读|更多|AI筛选|发送|换电话|换微信|发简历|查看职位|在线客服/.test(line);
    })
    .slice(0, 3);

  const identityText = normalizeComparableText(lines.join("|")).slice(0, 160);
  if (identityText.length < 2) {
    return "";
  }
  return identityText;
}

// 功能目的：同一会话同一草稿只发送一次；实现原因：轮询、URL 参数和 DOM 重绘可能重复触发发送入口。
function sendDraftOnce(sendKey, label) {
  const input = findChatInput();
  const draftText = input ? readChatInputText(input).trim() : "";
  if (!draftText) {
    showAutoChatNotice((label || "草稿") + "为空，已跳过发送");
    return false;
  }

  const baseKey = String(sendKey || makeDraftSendKey("draft", resolveConversationSendScope(""), draftText));
  const guardKeys = utilsUniqueKeys([
    baseKey,
    makeConversationDraftSendKey(baseKey, draftText)
  ]);

  if (hasAnySendKey(guardKeys, jobCopilotState.sentDraftKeys) || hasAnySendKey(guardKeys, jobCopilotState.activeSendKeys)) {
    showAutoChatNotice((label || "草稿") + "已发送过，本次跳过");
    return false;
  }

  guardKeys.forEach(function(key) {
    jobCopilotState.activeSendKeys.add(key);
  });

  try {
    const sent = clickSendButton(draftText);
    if (sent) {
      guardKeys.forEach(function(key) {
        jobCopilotState.sentDraftKeys.add(key);
      });
      jobCopilotState.autoChatSentMessages.add(normalizeAutoChatMessageKey(draftText).slice(0, 60));
      saveSentDraftKeys();
    }
    return sent;
  } finally {
    guardKeys.forEach(function(key) {
      jobCopilotState.activeSendKeys.delete(key);
    });
  }
}

// 功能目的：检查任一发送锁是否命中；实现原因：任务级和会话级两把锁任意命中都必须跳过。
function hasAnySendKey(keys, keySet) {
  return keys.some(function(key) {
    return keySet.has(key);
  });
}

// 功能目的：去重发送锁数组；实现原因：避免同一 key 重复写入造成无意义存储。
function utilsUniqueKeys(keys) {
  return Array.from(new Set(keys.filter(Boolean)));
}

// 功能目的：点击 BOSS 发送按钮前校验输入内容；实现原因：页面重绘时不能发送空内容或非本次草稿。
function clickSendButton(expectedDraftText) {
  var input = findChatInput();
  if (!input) {
    showAutoChatNotice("未找到聊天输入框，已跳过发送");
    return false;
  }

  if (expectedDraftText && !chatInputContainsDraft(input, expectedDraftText)) {
    showAutoChatNotice("输入框内容已变化，已跳过发送");
    return false;
  }

  prepareChatInputForSend(input);

  var sendButton = findSendButton();
  if (!sendButton) {
    showAutoChatNotice("未找到发送按钮，尝试使用 Enter 键发送");
    triggerEnterSend(input);
    return true;
  }

  enableBossSendButton(sendButton);
  safeClick(sendButton);
  return true;
}

// BOSS 会根据输入事件更新发送按钮状态，发送前补发一次事件，避免脚本写值后按钮仍处于旧状态。
function prepareChatInputForSend(input) {
  if (!input) {
    return;
  }
  try {
    input.focus({ preventScroll: true });
  } catch (error) {
    input.focus();
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findSendButton() {
  const selectors = [
    ".chat-conversation .btn-send",
    "button.btn-send",
    "button[type='send']"
  ];
  for (const selector of selectors) {
    const button = Array.from(document.querySelectorAll(selector)).find(isVisibleAutoReplyElement);
    if (button) {
      return button;
    }
  }
  return null;
}

function enableBossSendButton(button) {
  if (!button) {
    return;
  }
  button.disabled = false;
  button.removeAttribute("disabled");
}

function triggerEnterSend(input) {
  ["keydown", "keypress", "keyup"].forEach(function(eventType) {
    input.dispatchEvent(new KeyboardEvent(eventType, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
  });
}

// 功能目的：初始化自动聊天状态机；实现原因：发送后必须等待 HR 新消息，不能被轮询再次触发。
function ensureAutoChatGuards() {
  if (!(jobCopilotState.autoChatProcessedHrKeys instanceof Set)) {
    jobCopilotState.autoChatProcessedHrKeys = new Set();
  }
  if (typeof jobCopilotState.autoChatAwaitingHrReply !== "boolean") {
    jobCopilotState.autoChatAwaitingHrReply = false;
  }
  if (typeof jobCopilotState.autoChatLastCandidateMessageKey !== "string") {
    jobCopilotState.autoChatLastCandidateMessageKey = "";
  }
  if (typeof jobCopilotState.autoChatLastCandidateSendAt !== "number") {
    jobCopilotState.autoChatLastCandidateSendAt = 0;
  }
  if (typeof jobCopilotState.autoChatPendingReplySendKey !== "string") {
    jobCopilotState.autoChatPendingReplySendKey = "";
  }
  // 新增风控字段
  if (typeof jobCopilotState.autoChatLastHrMessageTime !== "number") {
    jobCopilotState.autoChatLastHrMessageTime = 0;
  }
  if (!Array.isArray(jobCopilotState.autoChatSendTimestamps)) {
    jobCopilotState.autoChatSendTimestamps = [];
  }
  if (typeof jobCopilotState.autoChatMaxRounds !== "number" || jobCopilotState.autoChatMaxRounds < 1) {
    jobCopilotState.autoChatMaxRounds = 10;
  }
}

// 功能目的：记录候选人已发送消息；实现原因：后续 HR 消息识别必须排除自己刚发的内容。
function markCandidateMessageSent(draftText) {
  ensureAutoChatGuards();
  const messageKey = normalizeAutoChatMessageKey(draftText);
  if (!messageKey) {
    return;
  }
  jobCopilotState.autoChatLastCandidateMessageKey = messageKey;
  jobCopilotState.autoChatLastCandidateSendAt = Date.now();
  jobCopilotState.autoChatAwaitingHrReply = true;
  jobCopilotState.autoChatSentMessages.add(messageKey.slice(0, 60));
}

// 功能目的：验证发送的消息确实出现在聊天列表中；实现原因：点击发送按钮不等于消息真的发出去了。
// 返回 true 表示在 DOM 中找到了刚发送的消息回显，false 表示可能发送失败。
function verifyMessageSent(draftText) {
  const normalized = normalizeComparableText(draftText).slice(0, 50);
  if (!normalized) return false;

  // 等待 DOM 渲染（消息回显需要时间）
  // 注意：这里不阻塞调用方，异步验证结果存入状态
  window.setTimeout(function() {
    const chatArea = document.querySelector(".chat-list, .dialog-list, .conversation-list, .chat-content, .im-content, [class*='chat-list'], [class*='message-list']");
    if (!chatArea) {
      jobCopilotState.lastMessageSendVerified = false;
      return;
    }

    const chatText = (chatArea.innerText || "").trim();
    // 检查聊天区域是否包含刚发送的消息
    const found = chatText.includes(normalized) || chatText.includes(draftText.slice(0, 30));
    jobCopilotState.lastMessageSendVerified = found;

    if (!found) {
      showAutoChatNotice("发送确认失败：消息未在聊天区域中找到，可能发送失败");
    }
  }, 1500);

  return true; // 默认乐观返回 true，异步验证结果用于后续决策
}

// 功能目的：同一会话同一草稿只发送一次；实现原因：自动聊天轮询、URL 参数和 DOM 重绘可能重复触发发送入口。
// 增强保护：
//   - 全局发送冷却：任意两次发送之间至少间隔 2 秒
//   - 发送时间戳记录：用于风控连续发送上限
//   - 发送后输入框验证：等待 500ms 后确认输入框已清空（消息已发出）
function sendDraftOnce(sendKey, label) {
  ensureAutoChatGuards();
  const input = findChatInput();
  const draftText = input ? readChatInputText(input).trim() : "";
  if (!draftText) {
    showAutoChatNotice((label || "草稿") + "为空，已跳过发送");
    return false;
  }

  const baseKey = String(sendKey || makeDraftSendKey("draft", resolveConversationSendScope(""), draftText));
  const guardKeys = utilsUniqueKeys([
    baseKey,
    makeConversationDraftSendKey(baseKey, draftText)
  ]);

  if (hasAnySendKey(guardKeys, jobCopilotState.sentDraftKeys) || hasAnySendKey(guardKeys, jobCopilotState.activeSendKeys)) {
    showAutoChatNotice((label || "草稿") + "已发送过，本次跳过");
    return false;
  }

  // 全局发送冷却：任意两次发送至少间隔 2 秒
  const now = Date.now();
  if (jobCopilotState.lastAnySendAt && (now - jobCopilotState.lastAnySendAt < 2000)) {
    showAutoChatNotice((label || "草稿") + "发送间隔过短，已跳过");
    return false;
  }

  guardKeys.forEach(function(key) {
    jobCopilotState.activeSendKeys.add(key);
  });

  try {
    const sent = clickSendButton(draftText);
    if (sent) {
      guardKeys.forEach(function(key) {
        jobCopilotState.sentDraftKeys.add(key);
      });
      jobCopilotState.lastAnySendAt = now;

      // 记录发送时间戳用于风控
      if (baseKey.includes("auto-opening") || baseKey.includes("auto-reply")) {
        markCandidateMessageSent(draftText);
        // 异步验证消息是否真的出现在聊天区域
        verifyMessageSent(draftText);
        jobCopilotState.autoChatSendTimestamps = jobCopilotState.autoChatSendTimestamps || [];
        jobCopilotState.autoChatSendTimestamps.push(now);
      }
      saveSentDraftKeys();
    }
    return sent;
  } finally {
    guardKeys.forEach(function(key) {
      jobCopilotState.activeSendKeys.delete(key);
    });
  }
}

// 功能目的：只提取可信 HR 消息；实现原因：BOSS 页面会把自己消息、系统卡片和按钮混在消息区域。
// 设计要点：
//   1. 严格选择器链：从最具体到最泛化，每个匹配都要过 isLikelyHrMessageElement 和 cleanPotentialHrMessageText
//   2. DOM 指纹去重：消息内容 + 元素结构特征 防止同一消息因 DOM 重绘被重复提取
//   3. 排除已读/送达状态标签：BOSS 会在每条消息底部追加送达/已读文本，用独立检测排除
//   4. 排除系统卡片：系统卡片通常有独立 class（system-tip/card-tip/notice），且文本模式固定
//   5. 排除候选人自己的消息回显：发送后页面会立即回显自己的消息，必须用 isCandidateEchoMessage 排除
function extractHrMessagesFromPage() {
  const messages = [];
  // 从具体到泛化，一旦找到足够多的真实消息就停止
  const selectors = [
    // 第1优先级：精确的消息气泡选择器（BOSS 主流版本）
    ".chat-message",
    ".message-item",
    ".im-message",
    ".msg-item",
    // 第2优先级：聊天列表中的直接子元素（限在对话区域内）
    ".chat-list > div",
    ".dialog-list > div",
    ".conversation-list > div",
    // 第3优先级：仅当以上都没找到时才用 class 包含匹配
    "[class*='chat-message']",
    "[class*='message-item']",
    "[class*='msg-item']",
    "[class*='im-message']"
  ];

  const seen = new Set();
  const seenContentFingerprints = new Set();

  for (const selector of selectors) {
    // 如果是泛化选择器且已经在前几轮找到了足够的消息，跳过
    if (messages.length >= 3 && (selector.startsWith("[class*=") || selector.includes("> div"))) {
      break;
    }

    const elements = document.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (seen.has(element)) continue;
      if (!isVisibleElement(element)) continue;
      seen.add(element);

      // 先做快速排除：检查元素 class 是否明确标记为系统/状态/自己
      if (isElementQuickReject(element)) continue;

      const text = cleanPotentialHrMessageText(element.innerText || "");
      if (!text) continue;

      // DOM 指纹去重：同内容同结构的消息只记录一次
      const fingerprint = buildMessageFingerprint(element, text);
      if (seenContentFingerprints.has(fingerprint)) continue;
      seenContentFingerprints.add(fingerprint);

      if (!isLikelyHrMessageElement(element, text)) continue;

      messages.push({
        role: "recruiter",
        content: text,
        createdAt: new Date().toISOString()
      });
    }

    // 如果已经找到消息，不再继续用更泛化的选择器
    if (messages.length > 0 && !selector.startsWith("[class*=")) {
      break;
    }
  }

  return messages;
}

// 功能目的：快速排除明显不是 HR 消息的 DOM 元素；实现原因：避免逐文本检查浪费性能。
function isElementQuickReject(element) {
  const classText = String(element.className || "");
  const tagName = element.tagName || "";

  // 排除系统提示卡片
  if (/\b(system-tip|card-tip|sys-tip|notice-tip|system-msg|sys-msg|auto-tip)\b/i.test(classText)) {
    return true;
  }

  // 排除已读/送达状态标签元素（BOSS 通常用独立 span 或 div 包裹）
  if (tagName === "SPAN" || tagName === "I" || tagName === "EM") {
    const text = (element.innerText || "").trim();
    // 短文本 + 状态关键词 → 极可能是状态标签
    if (text.length <= 10 && /^(已读|送达|未读|发送中|发送失败)$/.test(text)) {
      return true;
    }
    if (text.length <= 10 && /已读|送达/.test(text)) {
      return true;
    }
  }

  // 排除纯时间戳元素
  if (tagName === "TIME" || /\b(message-time|msg-time|chat-time|timestamp)\b/i.test(classText)) {
    return true;
  }

  // 排除输入框工具栏/表情/附件按钮区域
  if (element.closest(".chat-input, .chat-editor, .chat-toolbar, .chat-footer, .emoji-panel, .file-upload")) {
    return true;
  }

  // 排除左侧会话列表项（不是当前对话内容）
  if (element.closest(".chat-list, .conversation-list, .dialog-list, .chat-sidebar, .im-sidebar")) {
    // 但如果同时在右侧聊天内容区，则保留
    const chatContentArea = element.closest(".chat-content, .chat-main, .im-content, .dialog-content, .chat-detail, .chat-right");
    if (!chatContentArea) {
      return true;
    }
  }

  return false;
}

// 功能目的：生成消息 DOM 指纹；实现原因：同一消息可能被多个选择器命中或 DOM 重绘导致重复。
function buildMessageFingerprint(element, text) {
  // 用文本前80字符 + 元素在DOM中的结构位置生成指纹
  const normalized = normalizeComparableText(text).slice(0, 80);
  // 取元素的前3层父级标签名作为结构特征
  let structure = "";
  let parent = element;
  for (let i = 0; i < 3 && parent; i++) {
    structure += (parent.tagName || "") + "|";
    parent = parent.parentElement;
  }
  return normalized + "::" + structure;
}

// 功能目的：过滤消息文本噪声；实现原因：系统状态、按钮和自己话术不能作为 HR 回复。
// 关键改进：
//   - 已读/送达状态：BOSS 在每条消息下方追加的状态文本（如"已读""送达""12:30 已读"）
//   - 系统卡片：沟通机会、交换联系方式、简历请求等系统插入的卡片
//   - 候选人消息回显：自己刚发送的内容被页面渲染后可能被误读
//   - 时间戳：消息旁边的时间文本
//   - 纯数字/纯符号：无意义的噪声
function cleanPotentialHrMessageText(rawText) {
  const text = String(rawText || "").trim();
  if (!text || text.length < 2 || text.length > 800) {
    return "";
  }

  // 纯数字或纯符号（如只有时间或分隔线）
  if (/^[\d:：\s\-—\.\/]+$/.test(text)) {
    return "";
  }

  // 仅包含状态词（已读/送达/未读 等）
  if (/^(已读|送达|未读|发送中|发送失败|消息已删除|消息已撤回)$/.test(text)) {
    return "";
  }

  // 状态模式：时间 + 已读/送达
  if (/^\d{1,2}:\d{2}\s*(已读|送达|未读)$/.test(text)) {
    return "";
  }

  // 系统消息和卡片（扩展版）
  if (/系统消息|系统通知|以上为打招呼|沟通机会|发送简历|交换微信|交换电话|申请交换|已读|送达|投递成功|竞争者|查看详细分析|优秀竞争者|岗位竞争|发简历|换电话|换微信|交换手机号|交换联系方式/i.test(text)) {
    // 但如果文本长度>30且包含问号或实际内容，可能是 HR 在讨论这些话题，不排除
    if (text.length > 30 && /[?？]/.test(text)) {
      // HR 可能在说"你可以发送简历吗？"之类的话，保留
    } else {
      return "";
    }
  }

  // 候选人自己的话术回显（AI 生成的模板话术）
  if (/我关注到这个|JD 中的|JD中的|与我的项目经验较匹配|可以提供针对该岗位整理的简历|我对贵司.*岗位|我在.*平台看到|您好.*我是/i.test(text)) {
    return "";
  }

  // 纯链接或卡片链接
  if (/^(https?:\/\/|www\.)/i.test(text.trim()) && text.length < 120) {
    return "";
  }

  // 系统卡片模板文本
  if (/^(\[图片\]|\[文件\]|\[语音\]|\[视频\]|\[位置\]|\[名片\]|\[链接\])$/.test(text.trim())) {
    return "";
  }

  // BOSS 特定系统卡片模式
  if (/^(沟通机会|立即沟通|继续沟通|查看简历|邀请投递|发送附件|打招呼)$/.test(text.trim())) {
    return "";
  }

  return text;
}

// 功能目的：判断元素是否更像 HR 消息；实现原因：候选人消息通常位于右侧或带 self/mine/right 类。
// 增强排除：
//   - 候选人消息回显：发送后 DOM 渲染的自己的消息
//   - 系统卡片：有独立样式的系统插入内容
//   - 状态标签：已读/送达文本通常在消息底部独立渲染
//   - 时间标签：消息旁边的时间戳
function isLikelyHrMessageElement(element, text) {
  // 候选人消息回显检查（最高优先级）
  if (isCandidateEchoMessage(text)) {
    return false;
  }

  const classText = String(element.className || "");

  // 系统卡片的 class 特征
  if (/\b(system-tip|card-tip|sys-tip|notice-tip|system-msg|sys-msg|auto-tip|divider|split-line)\b/i.test(classText)) {
    return false;
  }

  // 候选人消息（右侧/自己发的）
  if (/self|mine|right|me|sender/i.test(classText)) {
    return false;
  }
  if (element.closest(".self,.mine,.right,[class*='self'],[class*='mine'],[class*='right']")) {
    return false;
  }

  // 检查元素是否在左侧（HR 消息通常在左侧）
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.left > window.innerWidth * 0.48) {
    // 但如果在移动端或窄屏，放宽限制
    if (window.innerWidth > 600) {
      return false;
    }
  }

  // 排除极小元素（通常是图标、状态点）
  if (rect.width < 30 && rect.height < 20) {
    return false;
  }

  // 检查文本中是否包含时间戳模式（消息旁边的时间标签可能被合并到消息文本中）
  // 如果文本主要是时间 + 短状态，不太可能是 HR 消息
  const timePatternCount = (text.match(/\d{1,2}:\d{2}/g) || []).length;
  const pureContent = text.replace(/\d{1,2}:\d{2}/g, "").replace(/\s+/g, "").trim();
  if (timePatternCount > 0 && pureContent.length < 4) {
    return false; // 主要是时间，几乎没有内容
  }

  // 检查元素中是否嵌套了已读/送达状态标签
  // BOSS 有时会把状态标签放在消息元素内部
  const statusElements = element.querySelectorAll("span, i, em, small, .status, .read-status, .delivery-status, [class*='status'], [class*='read'], [class*='delivery']");
  let statusText = "";
  for (let i = 0; i < statusElements.length; i++) {
    statusText += (statusElements[i].innerText || "").trim();
  }
  if (/^(已读|送达|未读)$/.test(statusText.trim())) {
    // 如果元素的文本去掉状态标签后几乎没有内容，则排除
    const contentWithoutStatus = text.replace(statusText.trim(), "").trim();
    if (contentWithoutStatus.length < 3) {
      return false;
    }
  }

  return true;
}

// 功能目的：识别自己刚发送的内容；实现原因：页面回显可能被消息选择器误读成 HR 回复。
function isCandidateEchoMessage(text) {
  ensureAutoChatGuards();
  const messageKey = normalizeAutoChatMessageKey(text);
  if (!messageKey) {
    return false;
  }
  if (messageKey === jobCopilotState.autoChatLastCandidateMessageKey) {
    return true;
  }
  return Array.from(jobCopilotState.autoChatSentMessages).some(function(sentKey) {
    return messageKey.includes(sentKey) || sentKey.includes(messageKey.slice(0, 30));
  });
}

// 功能目的：填入待发送回复并只调度一次发送；实现原因：轮询期间 pending 草稿不能反复填充和发送。
// 增强：
//   - 发送前验证输入框内容确实是本次草稿
//   - 发送后立即清空 pending 状态，防止重复发送
//   - 发送后等待输入框清空确认（消息已发出）
function flushPendingAutoChatDraft() {
  ensureAutoChatGuards();
  const pendingReply = String(jobCopilotState.autoChatPendingReply || "").trim();
  if (!pendingReply) {
    return false;
  }

  const input = findChatInput();
  if (!input) {
    return false;
  }

  const currentText = readChatInputText(input).trim();
  if (currentText && !chatInputContainsDraft(input, pendingReply)) {
    showAutoChatNotice("输入框已有内容，等待用户处理");
    return true;
  }

  const fillResult = fillDraft(pendingReply);
  if (!fillResult.ok) {
    showAutoChatNotice("填入回复失败: " + (fillResult.error || "未知"));
    // 填入失败，清除 pending 避免死循环
    jobCopilotState.autoChatPendingReply = "";
    return false;
  }

  const replySendKey = makeDraftSendKey("auto-reply", jobCopilotState.autoChatPendingHrKey || jobCopilotState.autoChatQueueItemId, pendingReply);
  if (jobCopilotState.autoChatPendingReplySendKey === replySendKey) {
    // 已经调度过发送，不要重复调度
    return true;
  }
  jobCopilotState.autoChatPendingReplySendKey = replySendKey;

  const recruiterMessage = jobCopilotState.autoChatPendingRecruiterMessage;
  const hrKey = jobCopilotState.autoChatPendingHrKey;
  
  // 延迟700ms发送，确保输入框内容已经完全填入
  window.setTimeout(function() {
    const sent = sendDraftOnce(replySendKey, "HR 回复");
    if (sent) {
      recordAutoChatDraft(recruiterMessage, pendingReply, hrKey);
      jobCopilotState.autoChatPendingReply = "";
      jobCopilotState.autoChatPendingRecruiterMessage = null;
      jobCopilotState.autoChatPendingHrKey = "";
      jobCopilotState.autoChatPendingReplySendKey = "";
      showAutoChatNotice("已发送回复（第 " + jobCopilotState.autoChatRoundCount + " 轮），等待 HR 下一条消息");
      return;
    }
    // 发送失败（可能已发送过），也清空 pending 防止死循环
    jobCopilotState.autoChatPendingReply = "";
    jobCopilotState.autoChatPendingRecruiterMessage = null;
    jobCopilotState.autoChatPendingHrKey = "";
    jobCopilotState.autoChatPendingReplySendKey = "";
    showAutoChatNotice("回复已处理，本条不会重复发送");
  }, 700);

  return true;
}

// 功能目的：记录已发送的自动聊天草稿；实现原因：上下文和等待状态必须与真实发送保持一致。
function recordAutoChatDraft(recruiterMessage, candidateDraft, hrKey) {
  if (recruiterMessage && recruiterMessage.content) {
    jobCopilotState.autoChatMessages.push({
      role: "recruiter",
      content: recruiterMessage.content,
      createdAt: new Date().toISOString()
    });
  }
  jobCopilotState.autoChatMessages.push({
    role: "candidate",
    content: candidateDraft,
    createdAt: new Date().toISOString()
  });
  jobCopilotState.autoChatRoundCount += 1;
  jobCopilotState.autoChatLastDraftText = candidateDraft;
  jobCopilotState.autoChatLastHrMessage = hrKey || jobCopilotState.autoChatLastHrMessage;
  markCandidateMessageSent(candidateDraft);
  
  // 发送后更新HR消息基准线，防止发送后立即重读旧HR消息
  primeAutoChatHrBaseline();
  
  // 记录发送日志
  logAutoChatRound("SEND", recruiterMessage ? recruiterMessage.content : "", candidateDraft);
}

// 功能目的：检测 HR 新消息后才生成下一句；实现原因：发送后的等待态可以彻底切断自我循环。
// 风控保护机制：
//   - 冷却期：每次发送后至少等待 12 秒才检测新消息（防止刚发送的自己的消息回显被误判）
//   - 连续发送上限：10分钟内最多连续发送 5 条（防止陷入对话循环）
//   - 相同消息抑制：同一 HR 消息在 30 秒内不重复处理
//   - 消息长度验证：太短的消息（<3字符）可能是状态标签残留，不触发回复
//   - 发送间隔递增：连续发送间隔从12秒递增到30秒（模拟真人行为）
//   - 消息数量变化检测：只有 HR 消息数量真正增加时才触发（防止DOM重绘导致旧消息被重复识别）
//   - 内容变化检测：HR消息内容必须与上次不同（排除页面刷新导致的消息重读）
async function checkForHrNewMessage() {
  ensureAutoChatGuards();
  if (!jobCopilotState.autoChatEnabled || jobCopilotState.autoChatStatus !== "chatting") {
    return;
  }
  if (jobCopilotState.autoChatSendInProgress) {
    return;
  }
  if (flushPendingAutoChatDraft()) {
    return;
  }
  // 冷却期检查：发送后必须等待足够时间
  const minCooldownMs = calcAutoChatCooldown();
  const timeSinceLastSend = Date.now() - jobCopilotState.autoChatLastCandidateSendAt;
  if (timeSinceLastSend < minCooldownMs) {
    return;
  }

  if (isActiveConversationHeadhunter()) {
    finishAutoChatSession("rejected", "当前会话疑似猎头，已按筛选策略排除");
    showAutoChatNotice("当前会话疑似猎头，聊天助手已停止");
    return;
  }

  const hrMessages = extractHrMessagesFromPage();
  if (hrMessages.length === 0) {
    return;
  }

  // 记录 HR 消息数量，用于检测是否有真正的新消息
  const currentHrMessageCount = hrMessages.length;
  const previousHrMessageCount = jobCopilotState._lastHrMessageCount || 0;

  // 验证 HR 消息：只取最后一条，且必须通过长度和模式校验
  const latestHrMsg = hrMessages[hrMessages.length - 1];
  const msgKey = normalizeAutoChatMessageKey(latestHrMsg.content);
  if (!msgKey || msgKey.length < 2) {
    return;
  }

  // 检查是否是自己的消息回显（最高优先级）
  if (isCandidateEchoMessage(latestHrMsg.content)) {
    return;
  }

  // 去重：已处理过的 HR 消息不再处理
  if (msgKey === jobCopilotState.autoChatLastHrMessage || jobCopilotState.autoChatProcessedHrKeys.has(msgKey)) {
    return;
  }

  // 同一 HR 消息 30 秒内不重复处理（防 DOM 重绘导致重复触发）
  const now = Date.now();
  if (jobCopilotState.autoChatLastHrMessageTime && (now - jobCopilotState.autoChatLastHrMessageTime < 30000) && msgKey === jobCopilotState.autoChatLastHrMessage) {
    return;
  }

  // 验证消息看起来像真实的 HR 回复（不是状态/系统文本）
  if (!isValidHrMessage(latestHrMsg.content)) {
    return;
  }

  if (await maybeHandleResumeRequestMessage(latestHrMsg.content, msgKey)) {
    jobCopilotState.autoChatProcessedHrKeys.add(msgKey);
    jobCopilotState.autoChatLastHrMessage = msgKey;
    jobCopilotState.autoChatLastHrMessageTime = Date.now();
    return;
  }

  // 关键检查：如果 HR 消息数量没有增加，且之前已经处理过消息，则说明没有真正的新消息
  // 这防止了 DOM 重绘导致旧消息被重复识别
  if (previousHrMessageCount > 0 && currentHrMessageCount <= previousHrMessageCount && jobCopilotState.autoChatProcessedHrKeys.size > 0) {
    return;
  }

  // 记录本次检测到的 HR 消息数量
  jobCopilotState._lastHrMessageCount = currentHrMessageCount;
  jobCopilotState.autoChatProcessedHrKeys.add(msgKey);
  jobCopilotState.autoChatLastHrMessage = msgKey;
  jobCopilotState.autoChatLastHrMessageTime = now;
  jobCopilotState.autoChatAwaitingHrReply = false;
  jobCopilotState.autoChatSendInProgress = true;

  // 对话日志
  logAutoChatRound("DETECT", latestHrMsg.content, "");

  try {
    showAutoChatNotice("检测到 HR 新消息，正在生成回复（第 " + jobCopilotState.autoChatRoundCount + " 轮）");
    const payload = await requestLocalJSON("/api/chat/auto/reply", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: jobCopilotState.autoChatQueueItemId,
        jobId: jobCopilotState.autoChatJobId,
        resumeId: jobCopilotState.autoChatResumeId,
        mode: jobCopilotState.autoChatMode,
        messages: jobCopilotState.autoChatMessages,
        hrNewMessage: latestHrMsg.content,
        roundCount: jobCopilotState.autoChatRoundCount
      })
    }, 90000);

    const reply = (payload.suggestion && payload.suggestion.recommendedReply) || "";
    const bossOperation = (payload.suggestion && payload.suggestion.bossOperation) || "";

    // 检测到 HR 索要简历 → 自动发送简历附件
    if (bossOperation === "sendResume") {
      showAutoChatNotice("检测到 HR 索要简历，正在自动发送简历附件...");
      try {
        const sendResult = await autoSendResumeToBoss();
        if (sendResult) {
          showAutoChatNotice("简历附件已自动发送");
          logAutoChatRound("SEND_RESUME", latestHrMsg.content, "自动发送简历附件成功");
          return;
        } else {
          showAutoChatNotice("自动发送简历失败，将通过文字回复告知");
          logAutoChatRound("SEND_RESUME_FAIL", latestHrMsg.content, "自动发送简历失败");
        }
      } catch (resumeErr) {
        showAutoChatNotice("自动发送简历异常: " + (resumeErr.message || "未知"));
        logAutoChatRound("SEND_RESUME_ERR", latestHrMsg.content, resumeErr.message || "");
      }
    }

    if (!reply || reply.length < 2) {
      // AI 没有生成有效回复，也标记为已处理避免死循环
      logAutoChatRound("SKIP", latestHrMsg.content, "AI 未生成有效回复");
      return;
    }
    
    // 对话日志
    logAutoChatRound("REPLY", latestHrMsg.content, reply);
    
    await waitForChatInput(3000);
    jobCopilotState.autoChatPendingReply = reply;
    jobCopilotState.autoChatPendingRecruiterMessage = latestHrMsg;
    jobCopilotState.autoChatPendingHrKey = msgKey;
    flushPendingAutoChatDraft();
  } catch (error) {
    showAutoChatNotice("生成聊天草稿失败: " + (error.message || "未知错误"));
    logAutoChatRound("ERROR", latestHrMsg.content, error.message || "未知错误");
  } finally {
    jobCopilotState.autoChatSendInProgress = false;
  }
}

// 功能目的：记录自动聊天每轮对话日志；实现原因：帮助调试和理解AI决策过程。
function logAutoChatRound(action, hrMessage, candidateReply) {
  if (typeof jobCopilotState._autoChatLog === "undefined") {
    jobCopilotState._autoChatLog = [];
  }
  // 最多保留50条日志
  if (jobCopilotState._autoChatLog.length > 50) {
    jobCopilotState._autoChatLog.shift();
  }
  jobCopilotState._autoChatLog.push({
    time: new Date().toISOString(),
    round: jobCopilotState.autoChatRoundCount,
    action: action,
    hrMessage: String(hrMessage || "").slice(0, 200),
    candidateReply: String(candidateReply || "").slice(0, 200),
    status: jobCopilotState.autoChatStatus
  });
  // 同步到控制台
  console.log("[AutoChat #" + jobCopilotState.autoChatRoundCount + "] " + action + " | HR: " + 
    String(hrMessage || "").slice(0, 80) + " | Reply: " + String(candidateReply || "").slice(0, 80));
}

// 功能目的：计算动态冷却时间；实现原因：连续发送越多冷却越长，模拟真人聊天节奏。
function calcAutoChatCooldown() {
  ensureAutoChatGuards();
  // 基础冷却 12 秒，每多一轮 +4 秒，最大 30 秒
  const base = 12000;
  const increment = 4000 * Math.max(0, jobCopilotState.autoChatRoundCount - 1);
  return Math.min(base + increment, 30000);
}

// 功能目的：验证消息看起来像真实的 HR 回复；实现原因：排除系统通知、状态文本、纯表情等非对话内容。
function isValidHrMessage(text) {
  const t = String(text || "").trim();
  if (t.length < 3) return false; // 太短不是真实回复
  if (t.length > 600) return false; // 太长可能是页面文本拼接

  // 纯表情或纯标点
  if (/^[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s\p{P}]+$/u.test(t)) {
    return false;
  }

  // 系统通知模式
  if (/^(系统消息|系统通知|温馨提示|自动回复)/.test(t)) {
    return false;
  }

  // 只包含"已读""送达"等状态词的变体
  const stripped = t.replace(/[\d:：\s]/g, "");
  if (/^(已读|送达|未读)$/.test(stripped)) {
    return false;
  }

  return true;
}

// ============================================================
// 自动发送简历功能
// 功能目的：当 HR 索要简历时，自动调用 BOSS API 发送简历附件
// 实现原因：reference 项目中通过 WebSocket 检测 body.type=7 系统消息，
//   当前项目通过 DOM 文本检测 + 后端 AI 判断来触发
// ============================================================

// 功能目的：从当前聊天页 URL 获取 securityId
function getSecurityIdFromChatURL() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("securityId") || "";
  } catch (e) {
    return "";
  }
}

// 功能目的：从 cookie 获取 BOSS 认证 token (bst)
function getBossZpToken() {
  const match = document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

// 功能目的：从 BOSS API 获取用户的加密简历 ID
// BOSS 在线简历列表 API，返回第一个（默认）简历的 encryptResumeId
async function fetchBossEncryptResumeId() {
  try {
    const zpToken = getBossZpToken();
    if (!zpToken) {
      console.warn("[JobCopilot] 无法获取 Zp_token，可能未登录 BOSS");
      return "";
    }

    const resp = await fetch("https://www.zhipin.com/wapi/zpgeek/resume/list?page=1&size=1", {
      headers: { "Zp_token": zpToken }
    });
    const data = await resp.json();
    if (data.zpData && data.zpData.resumeList && data.zpData.resumeList.length > 0) {
      const resume = data.zpData.resumeList[0];
      return resume.encryptResumeId || resume.resumeId || "";
    }
    return "";
  } catch (e) {
    console.warn("[JobCopilot] 获取 BOSS 简历列表失败:", e.message);
    return "";
  }
}

// 功能目的：自动发送简历给当前聊天的 HR
// 调用 BOSS API: POST /wapi/zpchat/exchange/request type=3
// 返回 true 表示发送成功
async function autoSendResumeToBoss() {
  // 检查用户是否开启了自动发送简历开关
  var autoSendEnabled = true;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      var storageData = await new Promise(function(resolve) {
        chrome.storage.local.get(["autoSendResume"], resolve);
      });
      autoSendEnabled = storageData.autoSendResume !== false;
    }
  } catch (e) {
    // 无法读取存储时默认开启
  }
  if (!autoSendEnabled) {
    console.log("[JobCopilot] 自动发送简历已关闭（用户设置），跳过");
    return false;
  }

  // 防止同一会话重复发送
  if (jobCopilotState.autoSendResumeDone) {
    console.log("[JobCopilot] 当前会话已发送过简历，跳过重复发送");
    return false;
  }

  const securityId = getSecurityIdFromChatURL();
  if (!securityId) {
    console.warn("[JobCopilot] 无法获取 securityId，跳过自动发送简历");
    return false;
  }

  const zpToken = getBossZpToken();
  if (!zpToken) {
    console.warn("[JobCopilot] 无法获取 Zp_token，跳过自动发送简历");
    return false;
  }

  const encryptResumeId = await fetchBossEncryptResumeId();
  if (!encryptResumeId) {
    console.warn("[JobCopilot] 无法获取 BOSS 简历 ID，跳过自动发送简历");
    return false;
  }

  try {
    // 构造 application/x-www-form-urlencoded 格式的 body
    const formBody = new URLSearchParams();
    formBody.append("securityId", securityId);
    formBody.append("type", "3");
    formBody.append("encryptResumeId", encryptResumeId);

    const resp = await fetch("https://www.zhipin.com/wapi/zpchat/exchange/request", {
      method: "POST",
      headers: {
        "Zp_token": zpToken,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: formBody.toString()
    });

    const data = await resp.json();
    if (data.zpData !== undefined && data.code === undefined) {
      // 成功：BOSS API 成功时返回 { zpData: ... }，失败时返回 { code: ..., message: ... }
      console.log("[JobCopilot] 简历发送成功", data);
      jobCopilotState.autoSendResumeDone = true;
      return true;
    } else if (data.code === 0) {
      console.log("[JobCopilot] 简历发送成功 (code=0)", data);
      jobCopilotState.autoSendResumeDone = true;
      return true;
    } else {
      console.warn("[JobCopilot] 简历发送失败:", data.message || JSON.stringify(data));
      return false;
    }
  } catch (e) {
    console.error("[JobCopilot] 发送简历请求异常:", e.message);
    return false;
  }
}

// 功能目的：启动 HR 简历请求响应器；实现原因：HR 明确索要简历时可以按用户开关自动发送默认简历。
function startResumeRequestResponder() {
  ensureAutoResumeReplyState();
  loadAutoResumeReplyConfig();
  if (jobCopilotState.autoResumeReplyTimer) {
    return;
  }

  jobCopilotState.autoResumeReplyTimer = window.setInterval(checkResumeRequestFromHr, 4000);
  window.setTimeout(checkResumeRequestFromHr, 1800);
  try {
    chrome.storage.onChanged.addListener(function(changes, areaName) {
      if (areaName === "local" && changes.autoSendResume) {
        applyAutoResumeReplyConfig({ enabled: changes.autoSendResume.newValue === true });
      }
    });
  } catch (e) {}
}

// 功能目的：初始化简历响应状态；实现原因：轮询、页面刷新和 SPA 重绘都必须共用同一套去重锁。
function ensureAutoResumeReplyState() {
  if (typeof jobCopilotState.autoResumeReplyEnabled !== "boolean") {
    jobCopilotState.autoResumeReplyEnabled = false;
  }
  if (typeof jobCopilotState.autoResumeReplyLoaded !== "boolean") {
    jobCopilotState.autoResumeReplyLoaded = false;
  }
  if (typeof jobCopilotState.autoResumeReplyInProgress !== "boolean") {
    jobCopilotState.autoResumeReplyInProgress = false;
  }
  if (!(jobCopilotState.autoResumeSentKeys instanceof Set)) {
    jobCopilotState.autoResumeSentKeys = new Set();
  }
  if (!(jobCopilotState.autoResumeProcessedKeys instanceof Set)) {
    jobCopilotState.autoResumeProcessedKeys = new Set();
  }
  if (!jobCopilotState.autoResumeSentKeysLoaded) {
    loadAutoResumeSentKeys();
    jobCopilotState.autoResumeSentKeysLoaded = true;
  }
}

// 功能目的：读取简历响应开关；实现原因：默认自动响应 HR，同时尊重用户明确保存的关闭选择。
function loadAutoResumeReplyConfig() {
  try {
    chrome.storage.local.get(["autoSendResume"], function(result) {
      applyAutoResumeReplyConfig({ enabled: !result || result.autoSendResume !== false });
    });
  } catch (e) {
    applyAutoResumeReplyConfig({ enabled: true });
  }
}

// 功能目的：应用简历响应配置；实现原因：弹窗开关变化后内容脚本需要立即生效。
function applyAutoResumeReplyConfig(config) {
  ensureAutoResumeReplyState();
  jobCopilotState.autoResumeReplyEnabled = Boolean(config && config.enabled);
  jobCopilotState.autoSendResumeEnabled = jobCopilotState.autoResumeReplyEnabled;
  jobCopilotState.autoResumeReplyLoaded = true;
}

// 功能目的：定时检测 HR 是否索要简历；实现原因：BOSS 聊天页没有稳定事件 API，只能轻量轮询当前会话。
async function checkResumeRequestFromHr() {
  ensureAutoResumeReplyState();
  if (!shouldRunAutoResumeResponder()) {
    return;
  }
  if (isActiveConversationHeadhunter()) {
    return;
  }

  const latestRequest = extractLatestResumeRequestFromPage();
  if (!latestRequest || !latestRequest.content) {
    return;
  }
  await maybeHandleResumeRequestMessage(latestRequest.content, latestRequest.key);
}

// 功能目的：判断是否允许执行简历响应；实现原因：只在 BOSS 聊天页和用户开启后触发。
function shouldRunAutoResumeResponder() {
  if (!isBossPage() || !location.pathname.includes("/web/geek/chat")) {
    return false;
  }
  if (!jobCopilotState.autoResumeReplyLoaded || !jobCopilotState.autoResumeReplyEnabled) {
    return false;
  }
  if (jobCopilotState.autoResumeReplyInProgress) {
    return false;
  }
  return true;
}

// 功能目的：处理单条 HR 简历请求；实现原因：自动聊天和独立轮询都必须复用同一套幂等逻辑。
async function maybeHandleResumeRequestMessage(messageText, providedMessageKey) {
  ensureAutoResumeReplyState();
  if (!jobCopilotState.autoResumeReplyEnabled || jobCopilotState.autoResumeReplyInProgress) {
    return false;
  }

  const normalizedRequestKey = providedMessageKey || normalizeAutoChatMessageKey(messageText);
  if (!normalizedRequestKey || !isResumeRequestText(messageText)) {
    return false;
  }

  const sendKey = makeAutoResumeSendKey(normalizedRequestKey);
  if (hasSentResumeForCurrentConversation() || hasResumeSentConfirmationInCurrentConversation()) {
    jobCopilotState.autoResumeSentKeys.add(sendKey);
    saveAutoResumeSentKeys();
    return true;
  }
  if (jobCopilotState.autoResumeProcessedKeys.has(sendKey)) {
    return true;
  }

  jobCopilotState.autoResumeReplyInProgress = true;
  jobCopilotState.autoResumeProcessedKeys.add(sendKey);
  try {
    const result = await sendFirstResumeToHr();
    if (result.ok) {
      jobCopilotState.autoResumeSentKeys.add(sendKey);
      saveAutoResumeSentKeys();
      showAutoChatNotice("HR 已索要简历，已发送默认简历");
      return true;
    }
    jobCopilotState.autoResumeProcessedKeys.delete(sendKey);
    showAutoChatNotice("HR 索要简历，但自动发送失败：" + (result.error || "未知错误"));
    return true;
  } finally {
    jobCopilotState.autoResumeReplyInProgress = false;
  }
}

// 功能目的：生成会话级简历发送锁；实现原因：同一 HR 会话只能响应一次简历请求。
function makeAutoResumeSendKey(messageKey) {
  return [
    "auto-resume-v2",
    resolveConversationSendScope("resume-request"),
    String(messageKey || "").slice(0, 100)
  ].join("|");
}

function hasSentResumeForCurrentConversation() {
  const conversationPrefix = [
    "auto-resume-v2",
    resolveConversationSendScope("resume-request")
  ].join("|");
  return Array.from(jobCopilotState.autoResumeSentKeys).some(function(key) {
    return String(key || "").startsWith(conversationPrefix);
  });
}

// 功能目的：读取已发送简历锁；实现原因：页面刷新后不能再次给同一个 HR 发送简历。
function loadAutoResumeSentKeys() {
  try {
    const rawValue = window.localStorage.getItem("jobCopilotAutoResumeSentKeys") || "[]";
    JSON.parse(rawValue).forEach(function(key) {
      if (key) {
        jobCopilotState.autoResumeSentKeys.add(key);
      }
    });
  } catch (e) {}
}

// 功能目的：保存已发送简历锁；实现原因：同一会话的简历响应需要跨页面生命周期保持幂等。
function saveAutoResumeSentKeys() {
  try {
    const keys = JSON.stringify(Array.from(jobCopilotState.autoResumeSentKeys).slice(-300));
    safeLocalStorageSet("jobCopilotAutoResumeSentKeys", keys);
  } catch (e) {}
}

// 功能目的：提取最近一条索要简历的 HR 消息；实现原因：只响应当前会话最后的明确请求。
function extractLatestResumeRequestFromPage() {
  const messages = extractResumeRequestMessagesFromPage();
  if (messages.length === 0) {
    return null;
  }
  return messages[messages.length - 1];
}

// 功能目的：扫描当前聊天区域的简历请求消息；实现原因：常规聊天提取会过滤“发简历”短句。
function extractResumeRequestMessagesFromPage() {
  const selectors = [
    ".chat-message",
    ".message-item",
    ".im-message",
    ".msg-item",
    ".chat-list > div",
    ".dialog-list > div",
    ".conversation-list > div",
    "[class*='chat-message']",
    "[class*='message-item']",
    "[class*='msg-item']"
  ];
  const seenKeys = new Set();
  const messages = [];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach(function(element) {
      const message = buildResumeRequestMessage(element);
      if (!message || seenKeys.has(message.key)) {
        return;
      }
      seenKeys.add(message.key);
      messages.push(message);
    });
    if (messages.length > 0 && !selector.startsWith("[class*=")) {
      break;
    }
  }
  return messages;
}

// 功能目的：从 DOM 节点构造简历请求消息；实现原因：系统按钮、候选人回显和无关消息必须在源头过滤。
function buildResumeRequestMessage(element) {
  if (!element || !isVisibleElement(element) || isElementQuickReject(element)) {
    return null;
  }

  const text = normalizeResumeRequestText(element.innerText || "");
  if (!text || !isResumeRequestText(text)) {
    return null;
  }
  if (!isLikelyHrMessageElement(element, text) || isResumeButtonLikeElement(element, text)) {
    return null;
  }

  const key = normalizeAutoChatMessageKey(text);
  if (!key) {
    return null;
  }
  return { content: text, key };
}

// 功能目的：清理简历请求文本；实现原因：消息气泡可能混入时间、已读和按钮文案。
function normalizeResumeRequestText(rawText) {
  return String(rawText || "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/已读|送达|未读|发送中|发送失败/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

// 功能目的：识别 HR 是否明确索要简历；实现原因：只对求职流程中的正常简历请求自动响应。
function isResumeRequestText(text) {
  const normalized = normalizeComparableText(text).toLowerCase();
  if (!/(简历|履历|cv|resume|pdf)/i.test(normalized)) {
    return false;
  }
  if (isResumeSentConfirmationText(normalized)) {
    return false;
  }
  if (/不用.*简历|不需要.*简历|无需.*简历|别发.*简历|不要.*简历|暂不.*简历|已收到.*简历|收到.*简历|看过.*简历|简历.*不合适/.test(normalized)) {
    return false;
  }
  return /发.*简历|简历.*发|发送.*简历|投递.*简历|传.*简历|提供.*简历|给.*简历|把.*简历|简历.*看一下|简历.*看看|方便.*简历|可以.*简历|能.*简历|麻烦.*简历|请.*简历|附件简历|在线简历|pdf简历|有.*简历.*吗|简历.*吗|cv.*吗|resume.*吗/i.test(normalized);
}

// 功能目的：识别 BOSS 返回的附件简历发送成功回执；实现原因：回执出现后页面会移除发送按钮，不能把它误判为发送失败或新的简历请求。
function isResumeSentConfirmationText(text) {
  const normalized = normalizeComparableText(text).toLowerCase();
  return /您的附件简历.{0,160}已发送给boss/.test(normalized)
    || /附件简历.{0,160}(?:已发送|发送成功)/.test(normalized);
}

function hasResumeSentConfirmationInCurrentConversation() {
  const conversation = document.querySelector(".chat-conversation");
  if (!conversation) {
    return false;
  }
  return isResumeSentConfirmationText(conversation.innerText || conversation.textContent || "");
}

// 功能目的：排除页面里的“发简历”按钮本身；实现原因：工具栏按钮不能被误识别成 HR 消息。
function isResumeButtonLikeElement(element, text) {
  const normalized = normalizeComparableText(text);
  if (!/^(发简历|发送简历|投递简历)$/.test(normalized)) {
    return false;
  }
  if (element.matches("button,a,[role='button']")) {
    return true;
  }
  return Boolean(element.querySelector("button,a,[role='button']"));
}

// 功能目的：兼容旧调用入口；实现原因：自动聊天模块仍可能按 bossOperation 调用该函数。
async function autoSendResumeToBoss() {
  ensureAutoResumeReplyState();
  if (!jobCopilotState.autoResumeReplyEnabled || jobCopilotState.autoResumeReplyInProgress) {
    return false;
  }

  const sendKey = makeAutoResumeSendKey("ai-boss-operation");
  if (hasSentResumeForCurrentConversation()) {
    return false;
  }

  const result = await sendFirstResumeToHr();
  if (result.ok) {
    jobCopilotState.autoResumeSentKeys.add(sendKey);
    saveAutoResumeSentKeys();
  }
  return result.ok;
}

// 功能目的：发送 BOSS 默认简历；实现原因：HR 索要简历时应走平台原生“发简历”能力。
async function sendFirstResumeToHr() {
  const existingDialog = findResumeDialog();
  if (existingDialog) {
    return chooseFirstResumeIfDialogVisible();
  }

  const resumeButton = findResumeSendButton();
  if (!resumeButton) {
    return { ok: false, error: "未找到发简历按钮" };
  }
  if (isDisabledControl(resumeButton)) {
    return { ok: false, error: "发简历按钮不可用" };
  }

  resumeButton.scrollIntoView({ block: "center", inline: "center" });
  safeClick(resumeButton);
  await sleep(900);

  const dialogResult = await chooseFirstResumeIfDialogVisible();
  if (!dialogResult.ok) {
    return dialogResult;
  }
  return { ok: true };
}

// 功能目的：定位聊天区发简历按钮；实现原因：不同 BOSS 版本按钮可能是 button、a 或 role=button。
function findResumeSendButton() {
  const candidates = [];
  document.querySelectorAll("button,a,[role='button'],span,div").forEach(function(element) {
    const text = normalizeButtonText(element);
    if (!isResumeSendButtonText(text)) {
      return;
    }

    const clickableElement = normalizeClickableElement(element);
    if (!clickableElement || !isVisibleElement(clickableElement)) {
      return;
    }

    candidates.push({
      element: clickableElement,
      score: scoreResumeSendButton(clickableElement, text)
    });
  });

  candidates.sort(function(left, right) {
    return right.score - left.score;
  });
  return candidates.length > 0 ? candidates[0].element : null;
}

// 功能目的：筛选发简历按钮文案；实现原因：不能误点查看简历、完善简历或简历详情。
function isResumeSendButtonText(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized || normalized.length > 20) {
    return false;
  }
  if (/查看|完善|编辑|预览|管理|新增|上传|附件|详情/.test(normalized)) {
    return false;
  }
  return /^(发简历|发送简历|投递简历|立即发简历)$/.test(normalized);
}

// 功能目的：给发简历按钮排序；实现原因：优先选择聊天输入区底部工具栏中的按钮。
function scoreResumeSendButton(element, text) {
  const rect = element.getBoundingClientRect();
  let score = text.includes("发简历") ? 100 : 60;
  if (rect.top > window.innerHeight * 0.6) {
    score += 40;
  }
  if (element.closest(".chat-input,.chat-editor,.chat-footer,.im-chat-input,[class*='toolbar']")) {
    score += 40;
  }
  if (isDisabledControl(element)) {
    score -= 80;
  }
  return score;
}

// 功能目的：识别控件禁用状态；实现原因：禁用按钮不能强行点击，避免页面异常。
function isDisabledControl(element) {
  if (!element) {
    return true;
  }
  const classText = String(element.className || "");
  return Boolean(
    element.disabled ||
    element.getAttribute("disabled") !== null ||
    element.getAttribute("aria-disabled") === "true" ||
    /\bdisabled\b|disable|forbid/i.test(classText)
  );
}

// 功能目的：在弹窗中选择第一个简历并确认；实现原因：BOSS 多简历场景需要按用户要求发送第一个。
async function chooseFirstResumeIfDialogVisible() {
  const dialog = await waitForResumeDialog(6000);
  if (!dialog) {
    return { ok: false, error: "未打开简历选择弹窗" };
  }

  const firstResume = findFirstResumeOption(dialog);
  if (firstResume) {
    firstResume.scrollIntoView({ block: "center", inline: "center" });
    safeClick(firstResume);
    await sleep(700);
  }

  const confirmButton = await waitForEnabledResumeConfirmButton(dialog, 3000);
  if (!confirmButton) {
    return { ok: false, error: firstResume ? "简历确认按钮未启用" : "未找到简历确认按钮" };
  }

  safeClick(confirmButton);
  const dismissed = await waitForResumeDialogDismissed(dialog, 5000);
  if (!dismissed) {
    closeResumeDialog(dialog);
    return { ok: false, error: "BOSS 未确认简历发送" };
  }
  return { ok: true };
}

async function waitForEnabledResumeConfirmButton(dialog, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = findResumeConfirmButton(dialog) || findResumeConfirmButton(document);
    if (button && !isDisabledControl(button)) {
      return button;
    }
    await sleep(200);
  }
  return null;
}

async function waitForResumeDialogDismissed(dialog, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!document.contains(dialog) || !isVisibleElement(dialog)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

function closeResumeDialog(dialog) {
  const dialogRoot = dialog && (
    dialog.closest("[data-type='boss-dialog'],[role='dialog'],.boss-dialog,.boss-dialog__wrapper") || dialog
  );
  const closeButton = dialogRoot && dialogRoot.querySelector(".boss-popup__close, .icon-close, [aria-label='关闭']");
  safeClick(closeButton);
}

// 功能目的：等待简历选择弹窗；实现原因：BOSS 弹窗由异步渲染生成。
async function waitForResumeDialog(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialog = findResumeDialog();
    if (dialog) {
      return dialog;
    }
    await sleep(200);
  }
  return null;
}

// 功能目的：定位简历弹窗；实现原因：页面 class 会变化，只能按弹窗结构和简历文案综合判断。
function findResumeDialog() {
  const exactDialogs = document.querySelectorAll(".choose-resume-dialog");
  for (const exactDialog of exactDialogs) {
    if (isVisibleElement(exactDialog)) {
      return exactDialog;
    }
  }

  const selectors = [
    "[role='dialog']",
    ".dialog",
    ".modal",
    ".popup",
    ".pop-wrap",
    "[class*='dialog']",
    "[class*='modal']",
    "[class*='popup']",
    "[class*='pop']"
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      const text = (element.innerText || "").trim();
      if (isVisibleElement(element) && /请选择要发送的简历|已上传附件/.test(text)) {
        return element.querySelector(".choose-resume-dialog") || element;
      }
    }
  }
  return null;
}

// 功能目的：选择弹窗中的第一份简历；实现原因：用户要求默认发送第一个简历。
function findFirstResumeOption(dialog) {
  const preferredOption = dialog.querySelector(".resume-list .list-item");
  if (preferredOption && isVisibleElement(preferredOption)) {
    return preferredOption;
  }
  const selectors = [
    "label",
    "li",
    ".resume-item",
    "[class*='resume']",
    "[class*='option']",
    "[class*='item']"
  ];

  for (const selector of selectors) {
    const elements = dialog.querySelectorAll(selector);
    for (const element of elements) {
      const option = normalizeResumeOptionElement(element);
      if (option) {
        return option;
      }
    }
  }
  return null;
}

// 功能目的：归一化可点击简历选项；实现原因：真实点击点可能是 label、li 或内部 radio。
function normalizeResumeOptionElement(element) {
  if (!element || !isVisibleElement(element)) {
    return null;
  }
  const text = (element.innerText || "").trim();
  if (!/简历|在线|附件|PDF|pdf|doc|docx/.test(text)) {
    return null;
  }
  if (/取消|确定|确认|发送|关闭|管理|新增|上传|编辑|预览/.test(text) && text.length < 20) {
    return null;
  }

  const input = element.querySelector("input[type='radio'],input[type='checkbox']");
  if (input && !input.disabled) {
    return input;
  }
  return element.closest("label,li,[role='option'],[class*='item']") || element;
}

// 功能目的：定位简历发送确认按钮；实现原因：选择首份简历后仍需提交平台弹窗。
function findResumeConfirmButton(root) {
  const candidates = [];
  root.querySelectorAll("button,a,[role='button'],span,div").forEach(function(element) {
    const text = normalizeButtonText(element);
    if (!/^(发送|确定|确认|提交|立即发送|发给TA|发给对方)$/.test(text)) {
      return;
    }
    const clickableElement = normalizeClickableElement(element);
    if (clickableElement && isVisibleElement(clickableElement)) {
      candidates.push(clickableElement);
    }
  });
  return candidates.length > 0 ? candidates[0] : null;
}

// 功能目的：在自动投递打开的 BOSS 聊天页中持续回复 HR；实现原因：无障碍模式不能依赖人工盯屏等待 HR。
function startCodexAutoReplyLoopWhenReady() {
  if (jobCopilotState.codexAutoReplyLoopStarted) {
    return;
  }
  jobCopilotState.codexAutoReplyLoopStarted = true;

  window.setTimeout(function() {
    codexAutoReplyTick();
    window.setInterval(codexAutoReplyTick, 1000);
  }, 600);
}

async function codexAutoReplyTick() {
  if (!jobCopilotState.codexAutoReplyMonitorEnabled || !isBossChatPageForCodexReply()) {
    return;
  }
  const interruptionMessage = detectBossInterruption();
  if (interruptionMessage) {
    jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 60 * 1000;
    showAutoChatNotice(interruptionMessage + "，自动操作已暂停，请完成平台验证后继续");
    return;
  }
  if (jobCopilotState.codexAutoReplyRunning || jobCopilotState.autoChatSendInProgress) {
    return;
  }
  if (Date.now() < Number(jobCopilotState.codexAutoReplyNextActionAt || 0)) {
    return;
  }

  if (!jobCopilotState.codexAutoReplyPendingConversation) {
    await selectNextUnreadConversationForCodexReply();
    return;
  }

  const conversationContext = readActiveCodexConversationContext();
  if (!isPendingCodexConversationActive(conversationContext)) {
    if (Date.now() - Number(jobCopilotState.codexAutoReplyPendingConversation.selectedAt || 0) > 15000) {
      clearCodexAutoReplyPendingConversation(20, 35);
    }
    return;
  }
  const chatPolicy = globalThis.JobCopilotBossChatPolicy;
  const context = await resolveCodexAutoReplyContext();
  // 业务规则：HR 每次发来新消息都继续回复，不再按会话轮数停止。
  // 防止自循环由 HR 消息键去重、候选人消息回显识别和发送锁负责。
  if (!context || !context.jobId) {
    clearCodexAutoReplyPendingConversation(20, 35);
    return;
  }

  const latestHrMessage = extractLatestHrMessageForCodexReply();
  if (!latestHrMessage || latestHrMessage.text.length < 1) {
    if (Date.now() - Number(jobCopilotState.codexAutoReplyPendingConversation.selectedAt || 0) > 8000) {
      clearCodexAutoReplyPendingConversation(1, 2);
    }
    return;
  }

  const messageKey = context.queueItemId + "|" + context.jobId + "|" + latestHrMessage.key;
  if (jobCopilotState.codexAutoReplyProcessedKeys.has(messageKey)) {
    clearCodexAutoReplyPendingConversation(8, 15);
    return;
  }
  if (jobCopilotState.autoChatLastCandidateSendAt > 0 && Date.now() - jobCopilotState.autoChatLastCandidateSendAt < 1800) {
    return;
  }

  jobCopilotState.codexAutoReplyRunning = true;
  jobCopilotState.codexAutoReplyProcessedKeys.add(messageKey);
  try {
    const messages = buildCodexAutoReplyMessages(latestHrMessage.text);
    const pendingRecruiterText = buildPendingRecruiterTextForCodexReply(messages, latestHrMessage.text);
    const resumeRequested = isResumeRequestText(pendingRecruiterText);
    let resumeResult = null;
    if (resumeRequested) {
      showAutoChatNotice("HR 正在索要简历，正在立即同意并发送...");
      resumeResult = await sendResumeForCodexConversation(latestHrMessage.text, latestHrMessage.key);
      if (!resumeResult.ok) {
        jobCopilotState.codexAutoReplyProcessedKeys.delete(messageKey);
        jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 10 * 1000;
        closeResumeDialog(findResumeDialog());
        showAutoChatNotice("简历尚未发送成功，本条不会谎称已发送，10 秒后重试：" + (resumeResult.error || "未知错误"));
        return;
      }
    }

    showAutoChatNotice("检测到 HR 新消息，正在生成自动回复...");
    const payload = await requestLocalJSON("/api/chat/auto/reply", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: context.queueItemId,
        jobId: context.jobId,
        jobTitle: context.jobTitle,
        jobCompany: context.jobCompany,
        jobLocation: context.jobLocation,
        jobSalary: context.jobSalary,
        jobDescription: context.jobDescription,
        resumeId: context.resumeId,
        mode: context.mode,
        messages: messages,
        hrNewMessage: latestHrMessage.text,
        roundCount: context.roundCount
      })
    }, 90000);

    const suggestion = payload && payload.suggestion;
    const replyText = cleanAutoReplyText(suggestion && suggestion.recommendedReply);
    const replyGenerator = cleanAutoReplyText(suggestion && suggestion.generator);
    if (!replyText || !["codex", "deepseek", "zhipu", "fixed_template"].includes(replyGenerator)) {
      jobCopilotState.codexAutoReplyProcessedKeys.delete(messageKey);
      jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 10 * 1000;
      showAutoChatNotice("自动回复服务未返回有效内容，本条未发送，将稍后重试");
      return;
    }

    const bossOperation = cleanAutoReplyText(suggestion && suggestion.bossOperation);
    if (bossOperation === "sendResume" && (!resumeResult || !resumeResult.ok)) {
      showAutoChatNotice("HR 正在索要简历，正在自动同意并发送简历...");
      resumeResult = await sendResumeForCodexConversation(latestHrMessage.text, latestHrMessage.key);
      if (!resumeResult.ok) {
        jobCopilotState.codexAutoReplyProcessedKeys.delete(messageKey);
        jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 10 * 1000;
        closeResumeDialog(findResumeDialog());
        showAutoChatNotice("简历尚未发送成功，本条不会谎称已发送，10 秒后重试：" + (resumeResult.error || "未知错误"));
        return;
      }
    }

    const sent = await fillAndSendCodexAutoReply(replyText, context, messageKey);
    if (!sent) {
      jobCopilotState.codexAutoReplyProcessedKeys.delete(messageKey);
      jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 10 * 1000;
      showAutoChatNotice("输入框不可用或已有人工草稿，本条未发送，将稍后重试");
      return;
    }

    jobCopilotState.autoChatRoundCount = context.roundCount + 1;
    jobCopilotState.autoChatLastHrMessage = latestHrMessage.text;
    jobCopilotState.autoChatLastHrMessageTime = Date.now();
    jobCopilotState.autoChatLastCandidateSendAt = Date.now();
    jobCopilotState.autoChatMessages = messages.concat([{
      role: "candidate",
      content: replyText,
      createdAt: new Date().toISOString()
    }]).slice(-20);
    saveCodexAutoReplyProcessedKeys();
    const generatorLabel = replyGenerator === "codex"
      ? "Codex"
      : (replyGenerator === "deepseek" ? "DeepSeek" : (replyGenerator === "zhipu" ? "智谱 GLM" : "岗位和简历本地规则"));
    showAutoChatNotice("已使用" + generatorLabel + "自动回复 HR，继续等待下一条消息");
    resetCodexAutoReplyConversationListToTop();
    clearCodexAutoReplyPendingConversation(1, 2);
  } catch (error) {
    jobCopilotState.codexAutoReplyProcessedKeys.delete(messageKey);
    jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 10 * 1000;
    showAutoChatNotice("自动回复失败：" + (error.message || "未知错误"));
  } finally {
    jobCopilotState.codexAutoReplyRunning = false;
  }
}

// 业务规则：聊天列表最后一条由 HR 发出时即进入回复；只跳过关闭和明确终止的会话。
async function selectNextUnreadConversationForCodexReply() {
  const chatPolicy = globalThis.JobCopilotBossChatPolicy;
  if (!chatPolicy) {
    return false;
  }

  const unreadRows = Array.from(document.querySelectorAll(".friend-content")).filter(function(row) {
    const previewElement = row.querySelector(".last-msg-text");
    const lastMessage = row.querySelector(".last-msg");
    const previewText = cleanAutoReplyText(previewElement && previewElement.innerText);
    return isVisibleAutoReplyElement(row)
      && previewElement
      && lastMessage
      && !lastMessage.querySelector(".message-status")
      && !isCandidateEchoMessage(previewText)
      && !isBossConversationSystemPreview(previewText);
  });
  // 用户明确要求 HR 索要简历时优先处理，避免普通会话排队导致简历迟迟未发。
  unreadRows.sort(function(left, right) {
    const leftPreview = cleanAutoReplyText(left.querySelector(".last-msg-text")?.innerText);
    const rightPreview = cleanAutoReplyText(right.querySelector(".last-msg-text")?.innerText);
    const leftResumePriority = isResumeRequestText(leftPreview) || isResumeSentConfirmationText(leftPreview);
    const rightResumePriority = isResumeRequestText(rightPreview) || isResumeSentConfirmationText(rightPreview);
    return Number(rightResumePriority) - Number(leftResumePriority);
  });
  if (unreadRows.length === 0) {
    advanceCodexAutoReplyConversationList();
    return false;
  }

  let queueItems = [];
  try {
    const payload = await requestLocalJSON("/api/delivery/queue", { method: "GET" });
    queueItems = Array.isArray(payload && payload.items) ? payload.items : [];
  } catch (error) {
    queueItems = [];
  }

  for (const row of unreadRows) {
    const rowContext = readCodexConversationRowContext(row);
    if (!rowContext) {
      continue;
    }
    const queueItem = typeof chatPolicy.findMatchingQueueItem === "function"
      ? chatPolicy.findMatchingQueueItem(queueItems, rowContext)
      : null;

    jobCopilotState.codexAutoReplyPendingConversation = {
      key: [rowContext.recruiterName, rowContext.company, rowContext.preview].join("|"),
      recruiterName: rowContext.recruiterName,
      company: rowContext.company,
      preview: rowContext.preview,
      selectedAt: Date.now(),
      roundCount: 0
    };
    jobCopilotState.codexAutoReplyCurrentQueueItem = queueItem;
    jobCopilotState.codexAutoReplyNextActionAt = Date.now() + 900 + Math.floor(Math.random() * 600);
    showAutoChatNotice("发现 " + (rowContext.company || rowContext.recruiterName || "HR") + " 的新消息，正在打开会话...");
    // BOSS 当前列表把切换会话的事件绑定在 friend-content 内部的文字区域。
    const clickTarget = row.querySelector(".text") || row.querySelector(".name-box") || row;
    safeClick(clickTarget);
    return true;
  }

  advanceCodexAutoReplyConversationList();
  return false;
}

// 业务规则：BOSS 的建联状态不是 HR 发言，不能占用自动回复队列。
function isBossConversationSystemPreview(text) {
  const normalized = normalizeComparableText(text);
  return /^您正在与boss.{0,80}沟通$/i.test(normalized);
}

function readCodexConversationRowContext(row) {
  if (!row) {
    return null;
  }
  const nameBox = row.querySelector(".name-box");
  const nameParts = nameBox ? Array.from(nameBox.children).filter(function(element) {
    return element.tagName === "SPAN";
  }).map(function(element) {
    return cleanAutoReplyText(element.innerText || element.textContent);
  }) : [];
  const nameElement = row.querySelector(".name-text");
  const previewElement = row.querySelector(".last-msg-text");
  return {
    recruiterName: nameParts[0] || cleanAutoReplyText(nameElement && nameElement.innerText),
    company: nameParts[1] || "",
    role: nameParts[2] || "",
    title: "",
    preview: cleanAutoReplyText(previewElement && previewElement.innerText)
  };
}

function readActiveCodexConversationContext() {
  const selectedRow = document.querySelector(".friend-content.selected");
  const context = readCodexConversationRowContext(selectedRow) || {};
  const baseInfo = document.querySelector(".chat-conversation .base-info");
  const recruiterNameElement = baseInfo && baseInfo.querySelector(".name-text");
  const roleElement = baseInfo && baseInfo.querySelector(".base-title");
  const companyElement = baseInfo && Array.from(baseInfo.children).find(function(element) {
    return !element.classList.contains("name-content")
      && !element.classList.contains("base-title")
      && cleanAutoReplyText(element.innerText || element.textContent);
  });
  const titleElement = document.querySelector(".chat-conversation .position-name");
  const salaryElement = document.querySelector(".chat-conversation .position-content .salary");
  const cityElement = document.querySelector(".chat-conversation .position-content .city");
  const descriptionElement = document.querySelector(
    ".chat-conversation .job-detail, .chat-conversation .job-description, .chat-conversation [class*='job-detail'], .chat-conversation [class*='job-description']"
  );
  context.recruiterName = context.recruiterName || cleanAutoReplyText(recruiterNameElement && recruiterNameElement.innerText);
  context.company = context.company || cleanAutoReplyText(companyElement && companyElement.innerText);
  context.role = context.role || cleanAutoReplyText(roleElement && roleElement.innerText);
  context.title = cleanAutoReplyText(titleElement && titleElement.innerText);
  context.salary = cleanAutoReplyText(salaryElement && salaryElement.innerText);
  context.location = cleanAutoReplyText(cityElement && cityElement.innerText);
  context.description = cleanAutoReplyText(descriptionElement && descriptionElement.innerText).slice(0, 1200);
  return context;
}

function isPendingCodexConversationActive(activeContext) {
  const pending = jobCopilotState.codexAutoReplyPendingConversation;
  const chatPolicy = globalThis.JobCopilotBossChatPolicy;
  if (!pending || !activeContext || !chatPolicy) {
    return false;
  }
  const pendingCompany = chatPolicy.normalizeMatchText(pending.company);
  const activeCompany = chatPolicy.normalizeMatchText(activeContext.company);
  const pendingRecruiter = chatPolicy.normalizeMatchText(pending.recruiterName);
  const activeRecruiter = chatPolicy.normalizeMatchText(activeContext.recruiterName);
  return Boolean(pendingCompany && activeCompany && pendingCompany === activeCompany)
    && Boolean(!pendingRecruiter || !activeRecruiter || pendingRecruiter === activeRecruiter);
}

function advanceCodexAutoReplyConversationList() {
  const now = Date.now();
  if (now - Number(jobCopilotState.codexAutoReplyLastListScrollAt || 0) < 1000) {
    return;
  }
  const scroller = document.querySelector(".user-list-content");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
    jobCopilotState.codexAutoReplyNextActionAt = now + 5 * 1000;
    return;
  }
  const nextScrollTop = scroller.scrollTop + Math.max(260, Math.floor(scroller.clientHeight * 0.75));
  if (nextScrollTop >= scroller.scrollHeight - scroller.clientHeight - 20) {
    scroller.scrollTop = 0;
    jobCopilotState.codexAutoReplyNextActionAt = now + 5 * 1000;
  } else {
    scroller.scrollTop = nextScrollTop;
    jobCopilotState.codexAutoReplyNextActionAt = now + 1000;
  }
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  jobCopilotState.codexAutoReplyLastListScrollAt = now;
}

function resetCodexAutoReplyConversationListToTop() {
  const scroller = document.querySelector(".user-list-content");
  if (!scroller || scroller.scrollTop <= 0) {
    return;
  }
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  jobCopilotState.codexAutoReplyLastListScrollAt = Date.now();
}

function clearCodexAutoReplyPendingConversation(minDelaySeconds, maxDelaySeconds) {
  const minDelay = Math.max(1, Number(minDelaySeconds) || 1);
  const maxDelay = Math.max(minDelay, Number(maxDelaySeconds) || minDelay);
  jobCopilotState.codexAutoReplyPendingConversation = null;
  jobCopilotState.codexAutoReplyCurrentQueueItem = null;
  jobCopilotState.codexAutoReplyNextActionAt = Date.now() + Math.floor((minDelay + Math.random() * (maxDelay - minDelay)) * 1000);
}

function isBossChatPageForCodexReply() {
  return location.hostname.includes("zhipin.com") && (
    location.pathname.includes("/web/geek/chat") ||
    location.pathname.includes("/web/geek/friend") ||
    document.querySelector('[contenteditable="true"], textarea')
  );
}

async function resolveCodexAutoReplyContext() {
  const task = readStoredAutoChatTask();
  const pendingQueueItem = jobCopilotState.codexAutoReplyCurrentQueueItem;
  const conversationContext = readActiveCodexConversationContext();
  const chatPolicy = globalThis.JobCopilotBossChatPolicy;
  const normalize = chatPolicy && typeof chatPolicy.normalizeMatchText === "function"
    ? chatPolicy.normalizeMatchText
    : cleanAutoReplyText;

  let queueItemId = cleanAutoReplyText(pendingQueueItem && pendingQueueItem.id);
  let jobId = cleanAutoReplyText(pendingQueueItem && pendingQueueItem.jobId);
  let resumeId = cleanAutoReplyText((pendingQueueItem && pendingQueueItem.resumeId) || jobCopilotState.autoChatResumeId || (task && task.resumeId));
  const mode = cleanAutoReplyText(jobCopilotState.autoChatMode || (task && task.mode)) || "积极主动";
  let maxRounds = Number(jobCopilotState.autoChatMaxRounds || (task && task.maxRounds) || 10);
  if (!Number.isFinite(maxRounds) || maxRounds <= 0) {
    maxRounds = 10;
  }

  if ((!jobId || !queueItemId) && pendingQueueItem) {
    const queueItem = await findCurrentAutoReplyQueueItem(queueItemId);
    if (queueItem) {
      queueItemId = queueItemId || cleanAutoReplyText(queueItem.id);
      jobId = jobId || cleanAutoReplyText(queueItem.jobId);
      resumeId = resumeId || cleanAutoReplyText(queueItem.resumeId);
    }
  }

  const conversationKey = [
    normalize(conversationContext.company),
    normalize(conversationContext.recruiterName),
    normalize(conversationContext.title || conversationContext.role)
  ].filter(Boolean).join("_").slice(0, 100) || "unknown";
  queueItemId = queueItemId || "boss_chat_" + conversationKey;
  jobId = jobId || "boss_chat_job_" + conversationKey;

  jobCopilotState.autoChatQueueItemId = queueItemId;
  jobCopilotState.autoChatJobId = jobId;
  jobCopilotState.autoChatResumeId = resumeId;
  jobCopilotState.autoChatMode = mode;
  return {
    queueItemId: queueItemId,
    jobId: jobId,
    jobTitle: cleanAutoReplyText(conversationContext.title || conversationContext.role),
    jobCompany: cleanAutoReplyText(conversationContext.company),
    jobLocation: cleanAutoReplyText(conversationContext.location),
    jobSalary: cleanAutoReplyText(conversationContext.salary),
    jobDescription: cleanAutoReplyText(conversationContext.description),
    resumeId: resumeId,
    mode: mode,
    maxRounds: maxRounds,
    roundCount: Number(jobCopilotState.codexAutoReplyPendingConversation && jobCopilotState.codexAutoReplyPendingConversation.roundCount || 0)
  };
}

function readStoredAutoChatTask() {
  try {
    const rawTask = sessionStorage.getItem("jobCopilotAutoChatTask");
    if (!rawTask) {
      return null;
    }
    const task = JSON.parse(rawTask);
    return task && typeof task === "object" ? task : null;
  } catch (error) {
    return null;
  }
}

async function findCurrentAutoReplyQueueItem(queueItemId) {
  try {
    const payload = await requestLocalJSON("/api/delivery/queue", { method: "GET" });
    const items = Array.isArray(payload && payload.items) ? payload.items : [];
    if (queueItemId) {
      const matched = items.find(function(item) {
        return cleanAutoReplyText(item && item.id) === queueItemId;
      });
      if (matched) {
        return matched;
      }
    }

    const chatPolicy = globalThis.JobCopilotBossChatPolicy;
    return chatPolicy ? chatPolicy.findMatchingQueueItem(items, readActiveCodexConversationContext()) : null;
  } catch (error) {
    return null;
  }
}

function extractLatestHrMessageForCodexReply() {
  const directMessages = Array.from(document.querySelectorAll(".chat-conversation .message-item:not(.item-myself)")).map(function(element, index) {
    const textElement = findCodexMessageTextElement(element);
    const text = cleanAutoReplyText(textElement.innerText || textElement.textContent);
    return {
      text: text,
      top: element.getBoundingClientRect().top,
      key: cleanAutoReplyText(element.getAttribute("data-mid")) || text + "|" + index
    };
  }).filter(function(message) {
    return isUsefulHrMessageText(message.text);
  });
  if (directMessages.length > 0) {
    return directMessages[directMessages.length - 1];
  }

  const selectors = [
    ".item-friend .text",
    ".item-friend [class*='text']",
    ".message-left [class*='text']",
    ".message-item:not(.item-myself) [class*='text']",
    ".chat-message:not(.self) [class*='text']",
    "[class*='friend'] [class*='text']",
    "[class*='other'] [class*='text']",
    "[class*='left'] [class*='text']",
    "[class*='message']:not([class*='myself']):not([class*='self'])"
  ];

  const candidates = [];
  selectors.forEach(function(selector) {
    document.querySelectorAll(selector).forEach(function(element) {
      if (!isVisibleAutoReplyElement(element)) {
        return;
      }
      const text = cleanAutoReplyText(element.innerText || element.textContent);
      if (!isUsefulHrMessageText(text)) {
        return;
      }
      const className = collectAutoReplyClassName(element);
      if (/(myself|self|mine|right|geek|candidate|sender)/i.test(className)) {
        return;
      }
      candidates.push({
        text: text,
        top: element.getBoundingClientRect().top,
        key: text + "|" + Math.round(element.getBoundingClientRect().top)
      });
    });
  });

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort(function(left, right) {
    return left.top - right.top;
  });
  return candidates[candidates.length - 1];
}

function buildCodexAutoReplyMessages(hrText) {
  const messages = Array.from(document.querySelectorAll(".chat-conversation .message-item")).map(function(element) {
    const textElement = findCodexMessageTextElement(element);
    return {
      role: element.classList.contains("item-myself") ? "candidate" : "recruiter",
      content: cleanAutoReplyText(textElement.innerText || textElement.textContent),
      createdAt: new Date().toISOString()
    };
  }).filter(function(message) {
    return isUsefulHrMessageText(message.content);
  }).slice(-80);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  if (lastMessage && lastMessage.role === "recruiter" && cleanAutoReplyText(lastMessage.content) === cleanAutoReplyText(hrText)) {
    messages.pop();
  }
  // 最新 HR 消息由 hrNewMessage 单独提交，历史保留 79 条，使模型可看到本轮所有连续提问。
  return messages.slice(-79);
}

function findCodexMessageTextElement(messageElement) {
  if (!messageElement) {
    return null;
  }
  return messageElement.querySelector(".text-content")
    || messageElement.querySelector(".message-card-top-title")
    || messageElement.querySelector(".text")
    || messageElement;
}

function buildPendingRecruiterTextForCodexReply(messages, hrText) {
  const chatPolicy = globalThis.JobCopilotBossChatPolicy;
  const allMessages = (Array.isArray(messages) ? messages : []).concat([{
    role: "recruiter",
    content: cleanAutoReplyText(hrText)
  }]);
  if (!chatPolicy || typeof chatPolicy.collectPendingRecruiterMessages !== "function") {
    return cleanAutoReplyText(hrText);
  }
  return chatPolicy.collectPendingRecruiterMessages(allMessages).map(function(message) {
    return cleanAutoReplyText(message.content);
  }).filter(Boolean).join("\n");
}

async function fillAndSendCodexAutoReply(replyText, context, messageKey) {
  const input = findCodexAutoReplyInput();
  if (!input) {
    return false;
  }
  if (cleanAutoReplyText(readChatInputText(input))) {
    return false;
  }

  if (input.isContentEditable) {
    writeContentEditableDraft(input, replyText);
  } else {
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = replyText;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: replyText }));
  }
  await pacedSleep(800, 1200);
  const sendKey = makeDraftSendKey("codex-auto-reply", context.queueItemId + "|" + messageKey, replyText);
  return sendDraftOnce(sendKey, "Codex HR 回复") || hasRecordedDraftSend(sendKey, replyText);
}

// HR 索要简历时优先处理消息卡片里的“同意”，没有卡片则使用聊天工具栏“发简历”。
async function sendResumeForCodexConversation(messageText, messageKey) {
  ensureAutoResumeReplyState();
  const sendKey = makeAutoResumeSendKey(messageKey || normalizeAutoChatMessageKey(messageText));
  if (hasSentResumeForCurrentConversation() || hasResumeSentConfirmationInCurrentConversation()) {
    jobCopilotState.autoResumeSentKeys.add(sendKey);
    saveAutoResumeSentKeys();
    return { ok: true, alreadySent: true };
  }

  const consentButton = findLatestResumeConsentButton();
  let result;
  if (consentButton) {
    consentButton.scrollIntoView({ block: "center", inline: "center" });
    safeClick(consentButton);
    await sleep(900);
    result = await chooseFirstResumeIfDialogVisible();
  } else {
    result = await sendFirstResumeToHr();
  }

  if (result.ok) {
    jobCopilotState.autoResumeSentKeys.add(sendKey);
    saveAutoResumeSentKeys();
  }
  return result;
}

function findLatestResumeConsentButton() {
  const recruiterMessages = Array.from(document.querySelectorAll(".chat-conversation .message-item:not(.item-myself)")).reverse();
  for (const messageElement of recruiterMessages) {
    const messageText = cleanAutoReplyText(messageElement.innerText || messageElement.textContent);
    if (!isResumeRequestText(messageText)) {
      continue;
    }
    const controls = Array.from(messageElement.querySelectorAll("button,a,[role='button'],span,div"));
    for (const control of controls) {
      const controlText = cleanAutoReplyText(control.innerText || control.textContent).replace(/\s+/g, "");
      if (!/^(同意|接受|发送)$/.test(controlText)) {
        continue;
      }
      const clickable = normalizeClickableElement(control);
      if (clickable && isVisibleAutoReplyElement(clickable) && !isDisabledControl(clickable)) {
        return clickable;
      }
    }
  }
  return null;
}

function loadCodexAutoReplyProcessedKeys() {
  try {
    const values = JSON.parse(window.localStorage.getItem("jobCopilotCodexAutoReplyProcessedKeys") || "[]");
    (Array.isArray(values) ? values : []).forEach(function(key) {
      if (key) {
        jobCopilotState.codexAutoReplyProcessedKeys.add(String(key));
      }
    });
  } catch (error) {}
}

function saveCodexAutoReplyProcessedKeys() {
  try {
    const values = Array.from(jobCopilotState.codexAutoReplyProcessedKeys).slice(-500);
    safeLocalStorageSet("jobCopilotCodexAutoReplyProcessedKeys", JSON.stringify(values));
  } catch (error) {}
}

function findCodexAutoReplyInput() {
  const selectors = [
    ".chat-input [contenteditable='true']",
    ".input-area [contenteditable='true']",
    ".message-input [contenteditable='true']",
    "[contenteditable='true']",
    "textarea",
    "input[type='text']"
  ];
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));
    const matched = elements.find(function(element) {
      return isVisibleAutoReplyElement(element) && !element.disabled && !element.readOnly;
    });
    if (matched) {
      return matched;
    }
  }
  return null;
}

function findCodexAutoReplySendButton(input) {
  const root = input.closest(".chat-input, .input-area, .message-input, [class*='input'], [class*='chat']") || document;
  const candidates = Array.from(root.querySelectorAll("button, [role='button'], .btn, [class*='send']"));
  return candidates.find(function(element) {
    if (!isVisibleAutoReplyElement(element)) {
      return false;
    }
    const text = cleanAutoReplyText(element.innerText || element.textContent || element.getAttribute("aria-label") || element.className);
    return text.includes("发送") || /send/i.test(text);
  }) || null;
}

function isUsefulHrMessageText(text) {
  if (!text || text.length > 500) {
    return false;
  }
  const normalizedText = cleanAutoReplyText(text).replace(/[\[\]【】]/g, "");
  if (/^(已读|送达|发送中|发送失败)$/.test(normalizedText)) {
    return false;
  }
  const ignored = ["发送", "同步岗位到系统", "打开系统", "自动回复", "查看更多", "当前登录状态已失效"];
  return !ignored.some(function(value) {
    return text.includes(value);
  });
}

function collectAutoReplyClassName(element) {
  const values = [];
  let current = element;
  while (current && current !== document.body && values.length < 5) {
    values.push(String(current.className || ""));
    current = current.parentElement;
  }
  return values.join(" ");
}

function isVisibleAutoReplyElement(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function cleanAutoReplyText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function codexAutoReplyDelay(ms) {
  return new Promise(function(resolve) {
    window.setTimeout(resolve, ms);
  });
}

startResumeRequestResponder();


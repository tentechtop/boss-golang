const localServers = [
  "http://127.0.0.1:8083",
  ...Array.from({ length: 11 }, (_, index) => `http://127.0.0.1:${8080 + index}`).filter((server) => !server.endsWith(":8083"))
];
const hunterTitleBlockKeywords = ["猎头", "代招", "招聘顾问", "人事顾问", "RPO", "寻访"];
const hunterCompanyBlockKeywords = ["猎头", "人力资源", "人才服务", "人力资源服务", "企业管理咨询", "招聘顾问", "RPO"];
const hunterDescriptionBlockKeywords = ["猎头", "代招", "招聘顾问", "人才寻访", "人力资源服务", "接受委托招聘", "代客户招聘", "为客户招聘", "RPO"];
const defaultDeliveryStrategy = {
  minMatchScore: 75,
  batchPrepareLimit: 20,
  defaultChatMode: "专业稳重",
  includeTitleKeywords: [],
  excludeTitleKeywords: hunterTitleBlockKeywords,
  includeCompanyKeywords: [],
  excludeCompanyKeywords: hunterCompanyBlockKeywords,
  includeDescriptionKeywords: [],
  excludeDescriptionKeywords: hunterDescriptionBlockKeywords,
  greetingPrompt: ""
};

let currentJob = null;
let visibleAnalyses = [];
let queueItems = [];
let queueStats = { total: 0, statusCounts: {}, nextItemId: "" };
let activeQueueItem = null;
let deliveryStrategy = { ...defaultDeliveryStrategy };

document.getElementById("extractButton").addEventListener("click", extractCurrentJob);
document.getElementById("analyzeButton").addEventListener("click", analyzeAndSuggest);
document.getElementById("saveStrategyButton").addEventListener("click", saveStrategy);
document.getElementById("openBossJobsButton").addEventListener("click", openBossJobsPage);
document.getElementById("oneClickScanButton").addEventListener("click", startOneClickScan);
document.getElementById("scanVisibleButton").addEventListener("click", scanVisibleJobs);
document.getElementById("addHighMatchButton").addEventListener("click", () => addQueue(false));
document.getElementById("addAllButton").addEventListener("click", () => addQueue(true));
document.getElementById("loadQueueButton").addEventListener("click", loadQueue);
document.getElementById("prepareAllButton").addEventListener("click", prepareAllQueue);
document.getElementById("openNextButton").addEventListener("click", openNextQueueItem);
document.getElementById("fillButton").addEventListener("click", fillDraft);
document.getElementById("markDeliveredButton").addEventListener("click", () => updateActiveStatus("delivered"));
document.getElementById("markSkippedButton").addEventListener("click", () => updateActiveStatus("skipped"));
document.getElementById("markRejectedButton").addEventListener("click", () => updateActiveStatus("rejected"));
document.getElementById("startAutoChatButton").addEventListener("click", startAutoChat);
document.getElementById("stopAutoChatButton").addEventListener("click", stopAutoChat);
document.getElementById("saveAutoConfigButton").addEventListener("click", saveAutoConfig);
document.getElementById("batchAutoSendButton").addEventListener("click", batchAutoSendAll);
document.getElementById("oneClickFullPipelineButton").addEventListener("click", startOneClickFullPipeline);
document.getElementById("autoSendResumeCheckbox").addEventListener("change", toggleAutoSendResume);

// 功能目的：初始化自动发送简历开关状态；实现原因：默认自动响应 HR，用户仍可明确关闭真实发送动作。
(function initAutoSendResumeState() {
  chrome.storage.local.get(["autoSendResume"], function(data) {
    var checkbox = document.getElementById("autoSendResumeCheckbox");
    if (checkbox) {
      checkbox.checked = !data || data.autoSendResume !== false;
    }
  });
})();

loadStartup().catch((error) => setMeta(error.message));

// 功能目的：初始化插件状态；实现原因：策略和队列都由本地服务统一保存。
async function loadStartup() {
  await loadStrategy();
  await loadQueue();
}

// 功能目的：读取投递策略；实现原因：插件和 Web 控制台必须使用同一套规则。
async function loadStrategy() {
  const payload = await requestJSON("/api/delivery/strategy", { method: "GET" });
  deliveryStrategy = { ...defaultDeliveryStrategy, ...(payload.strategy || {}) };
  renderStrategy();
}

// 功能目的：保存投递策略；实现原因：用户可按目标岗位随时调整筛选边界。
async function saveStrategy() {
  try {
    deliveryStrategy = readStrategyForm();
    const payload = await requestJSON("/api/delivery/strategy", {
      method: "POST",
      body: JSON.stringify(deliveryStrategy)
    });
    deliveryStrategy = { ...defaultDeliveryStrategy, ...(payload.strategy || {}) };
    renderStrategy();
    setMeta("投递策略已保存");
  } catch (error) {
    setMeta(error.message);
  }
}

function renderStrategy() {
  document.getElementById("strategyMinScore").value = deliveryStrategy.minMatchScore;
  document.getElementById("strategyBatchLimit").value = deliveryStrategy.batchPrepareLimit;
  document.getElementById("strategyChatMode").value = deliveryStrategy.defaultChatMode || "专业稳重";
  document.getElementById("includeTitleKeywords").value = joinKeywords(deliveryStrategy.includeTitleKeywords);
  document.getElementById("excludeTitleKeywords").value = joinKeywords(deliveryStrategy.excludeTitleKeywords);
  document.getElementById("excludeCompanyKeywords").value = joinKeywords(deliveryStrategy.excludeCompanyKeywords);
  document.getElementById("strategyGreetingPrompt").value = deliveryStrategy.greetingPrompt || "";
}

function readStrategyForm() {
  return {
    ...defaultDeliveryStrategy,
    minMatchScore: readNumber("strategyMinScore", 75, 1, 100),
    batchPrepareLimit: readNumber("strategyBatchLimit", 20, 1, 20),
    defaultChatMode: document.getElementById("strategyChatMode").value,
    includeTitleKeywords: splitKeywords(document.getElementById("includeTitleKeywords").value),
    excludeTitleKeywords: splitKeywords(document.getElementById("excludeTitleKeywords").value),
    excludeCompanyKeywords: splitKeywords(document.getElementById("excludeCompanyKeywords").value),
    greetingPrompt: document.getElementById("strategyGreetingPrompt").value.trim()
  };
}

// 功能目的：打开 BOSS 职位页；实现原因：插件需要在目标页面上下文抓取可见岗位。
async function openBossJobsPage() {
  const bossJobsUrl = "https://www.zhipin.com/web/geek/jobs";
  const tabs = await chrome.tabs.query({ url: ["https://www.zhipin.com/web/geek/jobs*"] });
  if (tabs.length > 0 && tabs[0].id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    setMeta("已切换到 BOSS 职位页，请点击扫描可见岗位");
    return;
  }

  await chrome.tabs.create({ url: bossJobsUrl });
  setMeta("已打开 BOSS 职位页，登录后点击扫描可见岗位");
}

// 功能目的：读取当前岗位；实现原因：支持详情页临时生成话术。
async function extractCurrentJob() {
  try {
    const tab = await getActiveTab();
    currentJob = await sendTabMessage(tab, { type: "extractJob" });
    setMeta(`${currentJob.company || "未知公司"}｜${currentJob.title || "未知岗位"}`);
  } catch (error) {
    setMeta("当前页面未加载插件脚本");
  }
}

// 功能目的：生成单岗位话术；实现原因：不进入队列也能临时辅助沟通。
async function analyzeAndSuggest() {
  try {
    if (!currentJob) {
      await extractCurrentJob();
    }
    if (!currentJob) {
      return;
    }

    const jobPayload = await requestJSON("/api/jobs/analyze", {
      method: "POST",
      body: JSON.stringify({
        title: currentJob.title,
        company: currentJob.company,
        description: currentJob.description,
        candidateSkills: []
      })
    });

    const chatPayload = await requestJSON("/api/chat/suggest", {
      method: "POST",
      body: JSON.stringify({
        jobId: jobPayload.job.id,
        resumeId: "",
        messages: [],
        mode: deliveryStrategy.defaultChatMode
      })
    });

    setMeta(`匹配度 ${jobPayload.job.matchScore}｜${jobPayload.job.recommendation}`);
    document.getElementById("replyOutput").value = chatPayload.suggestion.recommendedReply;
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：扫描当前页岗位；实现原因：只处理用户当前可见岗位，不自动翻页刷职位。
async function scanVisibleJobs() {
  try {
    const tab = await getActiveTab();
    const extracted = await sendTabMessage(tab, { type: "extractVisibleJobs" });
    if (!extracted.jobs || extracted.jobs.length === 0) {
      setMeta("当前页没有识别到可见岗位");
      return;
    }

    const payload = await requestJSON("/api/jobs/visible/analyze", {
      method: "POST",
      body: JSON.stringify({
        jobs: extracted.jobs,
        candidateSkills: [],
        minScore: deliveryStrategy.minMatchScore
      })
    });

    visibleAnalyses = payload.jobs || [];
    await sendTabMessage(tab, { type: "markVisibleJobs", jobs: visibleAnalyses });
    renderVisibleJobs();
    setMeta(`已扫描 ${visibleAnalyses.length} 个岗位，建议 ${visibleAnalyses.filter((job) => job.eligible).length} 个，硬过滤 ${visibleAnalyses.filter((job) => job.hardBlocked).length} 个`);
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：一键全自动扫描；实现原因：自动打开BOSS → 翻页 → 抓岗位 → 入库 → 匹配 → 过滤猎头 → 薪资筛选。
async function startOneClickScan() {
  var statusEl = document.getElementById("oneClickScanStatus");
  var btn = document.getElementById("oneClickScanButton");
  
  if (btn.dataset.scanning === "true") {
    // 取消扫描
    chrome.runtime.sendMessage({ type: "cancelOneClickScan" }, function() {
      btn.textContent = "🚀 一键全自动扫描";
      btn.dataset.scanning = "false";
      btn.style.background = "#dc2626";
      statusEl.style.display = "none";
      setMeta("扫描已取消");
    });
    return;
  }

  btn.textContent = "⏳ 扫描中...";
  btn.dataset.scanning = "true";
  btn.style.background = "#f59e0b";
  statusEl.style.display = "block";
  statusEl.textContent = "正在打开 BOSS 搜索页...";

  // 启动后台扫描
  chrome.runtime.sendMessage({
    type: "startOneClickScan",
    config: {
      maxPages: 100,
      scrollDelay: 1200,
      minScore: deliveryStrategy.minMatchScore || 0
    }
  }, function(response) {
    if (chrome.runtime.lastError) {
      btn.textContent = "🚀 一键全自动扫描";
      btn.dataset.scanning = "false";
      btn.style.background = "#dc2626";
      statusEl.style.display = "none";
      setMeta("扫描失败: " + chrome.runtime.lastError.message);
      return;
    }
    if (!response || !response.ok) {
      btn.textContent = "🚀 一键全自动扫描";
      btn.dataset.scanning = "false";
      btn.style.background = "#dc2626";
      statusEl.textContent = "失败: " + ((response && response.error) || "未知错误");
      setMeta("扫描失败");
      return;
    }

    btn.textContent = "🚀 一键全自动扫描";
    btn.dataset.scanning = "false";
    btn.style.background = "#dc2626";
    statusEl.textContent = "完成！共抓取 " + response.totalJobsFound + " 个岗位，" +
      response.totalPagesScrolled + " 页，建议投递 " + response.totalInQueue + " 个，" +
      "过滤 " + response.totalBlocked + " 个，耗时 " + response.elapsedSeconds + " 秒";
    setMeta("一键扫描完成，已自动入库");
  });

  // 同时启动轮询状态更新
  var pollCount = 0;
  var maxPolls = 60;
  var pollInterval = setInterval(function() {
    pollCount++;
    if (pollCount > maxPolls) {
      clearInterval(pollInterval);
      return;
    }
    chrome.runtime.sendMessage({ type: "getOneClickScanStatus" }, function(statusResp) {
      if (chrome.runtime.lastError || !statusResp) return;
      if (!statusResp.running) {
        clearInterval(pollInterval);
        return;
      }
      var msg = "";
      if (statusResp.status === "opening") msg = "正在打开 BOSS 搜索页...";
      else if (statusResp.status === "scrolling") msg = "正在翻页扫描... 第" + statusResp.totalPagesScrolled + "页，已发现 " + statusResp.totalJobsFound + " 个岗位";
      else if (statusResp.status === "analyzing") msg = "正在分析+过滤 " + statusResp.totalJobsFound + " 个岗位...";
      else if (statusResp.status === "enqueuing") msg = "正在加入投递队列...";
      if (msg) {
        statusEl.style.display = "block";
        statusEl.textContent = msg;
      }
    });
  }, 2000);
}

// 功能目的：加入投递队列；实现原因：用户确认后才把岗位加载到系统。
async function addQueue(includeAll) {
  try {
    const selectedJobs = includeAll ? visibleAnalyses.filter((job) => !job.hardBlocked) : visibleAnalyses.filter((job) => job.eligible);
    if (selectedJobs.length === 0) {
      throw new Error(includeAll ? "没有未被硬过滤的岗位" : "没有符合策略的高匹配岗位");
    }

    await requestJSON("/api/delivery/queue/add", {
      method: "POST",
      body: JSON.stringify({
        jobs: selectedJobs.map((job) => job.source),
        candidateSkills: [],
        minScore: deliveryStrategy.minMatchScore,
        includeAll
      })
    });

    await loadQueue();
    setMeta(`已加入队列 ${selectedJobs.length} 个岗位`);
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：刷新队列；实现原因：状态由本地 Go 服务统一保存。
async function loadQueue() {
  const payload = await requestJSON("/api/delivery/queue", { method: "GET" });
  queueItems = payload.items || [];
  queueStats = payload.stats || { total: queueItems.length, statusCounts: {}, nextItemId: "" };
  renderProgress();
  renderQueue();
}

// 功能目的：批量准备队列；实现原因：把耗时的简历定制和开场白生成提前完成。
async function prepareAllQueue() {
  try {
    const payload = await requestJSON("/api/delivery/queue/prepare-all", {
      method: "POST",
      body: JSON.stringify({
        resumeId: "",
        mode: deliveryStrategy.defaultChatMode,
        limit: deliveryStrategy.batchPrepareLimit
      })
    });
    await loadQueue();
    setMeta(`已准备 ${payload.items.length} 个岗位，失败 ${payload.failed.length} 个`);
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：打开下一个岗位；实现原因：用户逐个确认投递，避免自动批量触发平台动作。
async function openNextQueueItem() {
  try {
    if (queueItems.length === 0) {
      await loadQueue();
    }

    let item = selectNextQueueItem();
    if (!item) {
      throw new Error("没有待处理岗位");
    }
    if (!item.openingDraft) {
      item = await prepareOneQueueItem(item.id);
    }

    activeQueueItem = item;
    document.getElementById("replyOutput").value = item.openingDraft || "";
    await updateQueueStatus(item.id, "opened");
    await chrome.tabs.create({ url: item.url });
    await loadQueue();
    setMeta(`已打开：${item.company || "未知公司"}｜${item.title || "未知岗位"}`);
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：填入草稿并自动发送。
async function fillDraft() {
  try {
    const text = document.getElementById("replyOutput").value;
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab, { type: "fillDraft", text });
    if (!response.ok) {
      throw new Error(response.error || "填入失败");
    }
    setMeta("草稿已填入并自动发送");
  } catch (error) {
    setMeta(error.message);
  }
}

// 功能目的：标记当前岗位状态；实现原因：投递进度必须由用户真实确认。
async function updateActiveStatus(status) {
  try {
    const item = activeQueueItem || selectNextQueueItem();
    if (!item) {
      throw new Error("没有当前岗位可标记");
    }

    await updateQueueStatus(item.id, status);
    activeQueueItem = null;
    await loadQueue();
    setMeta(statusLabel(status));
  } catch (error) {
    setMeta(error.message);
  }
}

async function prepareOneQueueItem(queueItemId) {
  const payload = await requestJSON("/api/delivery/queue/prepare", {
    method: "POST",
    body: JSON.stringify({
      queueItemId,
      resumeId: "",
      mode: deliveryStrategy.defaultChatMode
    })
  });
  return payload.item;
}

async function updateQueueStatus(queueItemId, status) {
  const payload = await requestJSON("/api/delivery/queue/status", {
    method: "POST",
    body: JSON.stringify({
      queueItemId,
      status,
      notes: ""
    })
  });
  return payload.item;
}

function selectNextQueueItem() {
  return queueItems.find((item) => item.status === "prepared")
    || queueItems.find((item) => item.status === "queued")
    || queueItems.find((item) => item.status === "opened")
    || queueItems.find((item) => !item.status);
}

// 功能目的：展示扫描结果；实现原因：用户需要看到岗位为何进入队列。
function renderVisibleJobs() {
  const container = document.getElementById("visibleJobs");
  container.innerHTML = "";
  visibleAnalyses.forEach((job) => {
    const item = document.createElement("div");
    item.className = `item ${job.eligible ? "high" : ""} ${job.hardBlocked ? "blocked" : ""}`;
    const reasons = (job.filterReasons || []).join("；") || "符合当前策略";
    item.innerHTML = `<strong>${escapeHTML(job.source.title || "未知岗位")}</strong>
      ${escapeHTML(job.source.company || "未知公司")}｜${job.analysis.matchScore}｜${visibleJobLabel(job)}
      <br>${escapeHTML(reasons)}`;
    container.appendChild(item);
  });
}

// 功能目的：展示投递队列；实现原因：用户需要掌握下一步和整体进度。
function renderQueue() {
  const container = document.getElementById("queueItems");
  container.innerHTML = "";
  queueItems.forEach((queueItem) => {
    const item = document.createElement("div");
    item.className = "item";
    const reasons = (queueItem.filterReasons || []).join("；");
    item.innerHTML = `<strong>${escapeHTML(queueItem.title || "未知岗位")}</strong>
      ${escapeHTML(queueItem.company || "未知公司")}｜${queueItem.matchScore}｜${statusLabel(queueItem.status)}
      ${reasons ? `<br>${escapeHTML(reasons)}` : ""}`;
    container.appendChild(item);
  });
}

function renderProgress() {
  const counts = queueStats.statusCounts || {};
  const container = document.getElementById("queueProgress");
  container.innerHTML = "";
  [
    ["总数", queueStats.total || 0],
    ["待准备", counts.queued || 0],
    ["已准备", counts.prepared || 0],
    ["已打开", counts.opened || 0],
    ["已投递", counts.delivered || 0],
    ["已跳过", (counts.skipped || 0) + (counts.rejected || 0)]
  ].forEach(([label, value]) => {
    const badge = document.createElement("span");
    badge.textContent = `${label} ${value}`;
    container.appendChild(badge);
  });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// 功能目的：调用本地 Go 服务；实现原因：业务逻辑统一放在后端处理。
async function requestJSON(path, options) {
  let lastError = null;
  for (const localServer of localServers) {
    try {
      const response = await fetch(localServer + path, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "请求失败");
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("本地服务不可用");
}

// 功能目的：向页面脚本发消息；实现原因：旧页面可能还没注入插件脚本，需要自动补注入。
async function sendTabMessage(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    await ensureContentScript(tab.id);
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

// 功能目的：动态注入页面脚本；实现原因：插件更新后无需用户手动刷新 BOSS 页面。
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["boss-search-policy.js", "content.js"]
  });
}

// 功能目的：获取当前标签；实现原因：插件所有动作只作用于用户当前页。
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("未找到当前标签页");
  }
  return tab;
}

function setMeta(message) {
  document.getElementById("meta").textContent = message;
}

function visibleJobLabel(job) {
  if (job.hardBlocked) {
    return "已过滤";
  }
  if (job.eligible) {
    return "建议投递";
  }
  return "低分参考";
}

function statusLabel(status) {
  const labels = {
    queued: "待准备",
    prepared: "已准备",
    opened: "已打开",
    filled: "已填入",
    delivered: "已投递",
    skipped: "已跳过",
    rejected: "不合适"
  };
  return labels[status] || "待准备";
}

function splitKeywords(value) {
  return String(value || "")
    .split(/[,，\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function joinKeywords(values) {
  return (values || []).join(", ");
}

function readNumber(elementId, defaultValue, minValue, maxValue) {
  const parsedValue = Number.parseInt(document.getElementById(elementId).value, 10);
  if (Number.isNaN(parsedValue)) {
    return defaultValue;
  }
  if (parsedValue < minValue) {
    return minValue;
  }
  if (parsedValue > maxValue) {
    return maxValue;
  }
  return parsedValue;
}

// 功能目的：转义显示文本；实现原因：页面采集内容不能直接进入 HTML。
function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ========== 自动聊天控制 ==========

// 功能目的：启动聊天助手；实现原因：向 BOSS 页面注入持续填入草稿指令。
async function startAutoChat() {
  try {
    const item = activeQueueItem || selectNextQueueItem();
    if (!item) {
      throw new Error("没有待处理岗位，请先打开下一个岗位或从队列选择");
    }
    if (!item.openingDraft) {
      throw new Error("该岗位还没有生成话术，请先点击一键准备");
    }

    const tab = await getActiveTab();
    const maxRounds = readNumber("autoChatMaxRounds", 10, 1, 20);

    setAutoChatStatus("正在启动聊天助手...");
    const response = await sendTabMessage(tab, {
      type: "startAutoChat",
      queueItemId: item.id,
      jobId: item.jobId,
      resumeId: item.resumeId || "",
      mode: deliveryStrategy.defaultChatMode || "积极主动",
      messages: [],
      roundCount: 0,
      maxRounds: maxRounds,
      openingDraft: item.openingDraft
    });

    if (response && response.ok) {
      setAutoChatStatus(`聊天助手已启动，持续监听HR回复并自动应答`);
      startStatusPolling(tab);
    } else {
      setAutoChatStatus("启动失败: " + ((response && response.error) || "未知错误"));
    }
  } catch (error) {
    setAutoChatStatus(error.message || "启动失败");
  }
}

// 功能目的：停止自动聊天；实现原因：用户手动终止。
async function stopAutoChat() {
  try {
    const tab = await getActiveTab();
    await sendTabMessage(tab, { type: "stopAutoChat" });
    setAutoChatStatus("已停止");
    stopStatusPolling();
  } catch (error) {
    setAutoChatStatus("停止失败: " + (error.message || ""));
  }
}

var statusPollingTimer = null;

function startStatusPolling(tab) {
  stopStatusPolling();
  statusPollingTimer = window.setInterval(async () => {
    try {
      const status = await sendTabMessage(tab, { type: "getAutoChatStatus" });
      if (status && status.status === "chatting") {
        setAutoChatStatus(`监听中，已发送${status.roundCount}轮`);
      } else if (status && status.status === "stopped") {
        setAutoChatStatus("已停止");
        stopStatusPolling();
      } else if (status && status.status === "completed") {
        setAutoChatStatus("聊天助手已完成");
        stopStatusPolling();
      }
    } catch (e) {
      // 忽略轮询错误
    }
  }, 2000);
}

function stopStatusPolling() {
  if (statusPollingTimer) {
    window.clearInterval(statusPollingTimer);
    statusPollingTimer = null;
  }
}

function setAutoChatStatus(message) {
  var el = document.getElementById("autoChatStatus");
  if (el) {
    el.textContent = message;
  }
}

// ========== 全自动模式 - 自动运行，弹窗只做监控 ==========

var fullAutoPollingTimer = null;

// 弹窗打开后自动开始轮询状态
(function startAutoMonitor() {
  pollFullAutoStatus();
  fullAutoPollingTimer = window.setInterval(pollFullAutoStatus, 3000);
})();

// 弹窗关闭时停止轮询
window.addEventListener("unload", function() {
  if (fullAutoPollingTimer) {
    window.clearInterval(fullAutoPollingTimer);
  }
});

// 功能目的：保存全自动配置。
async function saveAutoConfig() {
  try {
    var scanInterval = readNumber("autoScanInterval", 5, 1, 60);
    var maxRounds = readNumber("autoMaxRounds", 10, 1, 20);
    var minScore = readNumber("autoMinScore", 50, 1, 100);

    var response = await sendBackgroundMessage({
      type: "updateAutoConfig",
      config: {
        scanIntervalMinutes: scanInterval,
        maxChatRounds: maxRounds,
        minMatchScore: minScore
      }
    });

    if (response && response.ok) {
      setFullAutoStatus("配置已保存 - 扫描间隔" + scanInterval + "分钟，最低" + minScore + "分");
      setMeta("全自动配置已更新");
    } else {
      setFullAutoStatus("保存失败");
    }
  } catch (error) {
    setFullAutoStatus("保存失败: " + (error.message || ""));
  }
}

// 功能目的：轮询全自动状态。
async function pollFullAutoStatus() {
  try {
    var response = await sendBackgroundMessage({ type: "getAutoModeStatus" });
    if (response && response.state) {
      var s = response.state;
      setFullAutoStatus(
        "阶段：" + phaseLabel(s.phase) +
        " | 已扫描：" + (s.totalProcessed || 0) +
        " | 已聊天：" + (s.totalChatted || 0)
      );
    }
  } catch (e) {
    setFullAutoStatus("等待连接...");
  }
}

function phaseLabel(phase) {
  var labels = {
    idle: "空闲",
    scanning: "扫描岗位",
    enqueuing: "加入队列",
    preparing: "生成话术",
    chatting: "自动聊天"
  };
  return labels[phase] || phase;
}

function setFullAutoStatus(message) {
  var el = document.getElementById("fullAutoStatus");
  if (el) {
    el.textContent = message;
  }
}

// 功能目的：向 background.js 发消息；实现原因：插件弹窗和 background 通信。
async function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// 功能目的：批量全部自动发送；实现原因：遍历队列逐个打开Boss页面、填入话术并自动发送。
var batchAutoSendRunning = false;
var batchAutoSendStopFlag = false;

async function batchAutoSendAll() {
  if (batchAutoSendRunning) {
    batchAutoSendStopFlag = true;
    setMeta("正在停止批量发送...");
    return;
  }

  batchAutoSendRunning = true;
  batchAutoSendStopFlag = false;
  var totalSent = 0;
  var totalSkipped = 0;

  try {
    await loadQueue();
    var items = queueItems.filter(function(item) {
      return item.status === "prepared" || item.status === "queued" || item.status === "opened";
    });

    if (items.length === 0) {
      setMeta("没有待处理的岗位，请先生成话术");
      return;
    }

    setMeta("批量发送开始，共 " + items.length + " 个岗位...");
    var existingBossTabs = await chrome.tabs.query({
      url: ["https://www.zhipin.com/*", "https://*.zhipin.com/*"]
    });
    var batchWorkTab = JobCopilotBossSearchPolicy.selectReusableBossTab(existingBossTabs, null);

    for (var i = 0; i < items.length; i++) {
      if (batchAutoSendStopFlag) {
        setMeta("批量发送已停止，已完成 " + totalSent + " 个");
        break;
      }

      var item = items[i];
      if (!item.url) {
        totalSkipped++;
        continue;
      }
      if (!item.openingDraft) {
        try {
          item = await prepareOneQueueItem(item.id);
        } catch (e) {
          totalSkipped++;
          continue;
        }
      }
      if (!item.openingDraft) {
        totalSkipped++;
        continue;
      }

      setMeta("正在处理 " + (i + 1) + "/" + items.length + "：" + (item.company || "未知公司") + " " + (item.title || ""));

      try {
        // 复用同一个 BOSS 工作页，避免批处理为每个岗位新增标签页。
        var tab = batchWorkTab && batchWorkTab.id
          ? await chrome.tabs.update(batchWorkTab.id, { url: item.url, active: false })
          : await chrome.tabs.create({ url: item.url, active: false });
        batchWorkTab = tab;
        await sleep(1500); // 等待页面加载

        // 填入开场白
        await sendTabMessage(tab, { type: "fillDraft", text: item.openingDraft });
        await sleep(1500);

        // 标记完成
        await updateQueueStatus(item.id, "delivered");
        totalSent++;
      } catch (e) {
        totalSkipped++;
      }
    }

    setMeta("批量发送完成：成功 " + totalSent + " 个，跳过 " + totalSkipped + " 个");
  } catch (error) {
    setMeta("批量发送出错: " + (error.message || ""));
  } finally {
    batchAutoSendRunning = false;
    batchAutoSendStopFlag = false;
  }
}

// ========== 一键全流程（扫描 → 分析 → 入队 → 准备 → 投递） ==========

var fullPipelineRunning = false;

// 功能目的：一键全流程；实现原因：从扫描到投递全部自动化，无需多次点击
async function startOneClickFullPipeline() {
  if (fullPipelineRunning) {
    setMeta("全流程正在运行中，请等待完成...");
    return;
  }

  fullPipelineRunning = true;
  const pipelineBtn = document.getElementById("oneClickFullPipelineButton");
  if (pipelineBtn) {
    pipelineBtn.disabled = true;
    pipelineBtn.textContent = "⏳ 全流程运行中...";
  }

  try {
    // 步骤1：一键全自动扫描（翻页+入库+过滤）
    setMeta("🔍 步骤1/4：一键全自动扫描 BOSS 岗位...");
    console.log("[JobCopilot] 全流程开始：扫描");

    const scanResult = await new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({
        type: "startOneClickScan",
        config: { maxPages: 100, scrollDelay: 1200, minScore: 0 }
      }, function(response) {
        if (response && response.ok) {
          resolve(response);
        } else {
          reject(new Error((response && response.error) || "扫描失败"));
        }
      });
    });

    setMeta("📊 扫描完成：抓取 " + (scanResult.totalJobsFound || 0) + " 个，建议投递 " + (scanResult.totalInQueue || 0) + " 个（已自动入队）");

    if (!scanResult.totalInQueue) {
      setMeta("⚠️ 没有符合策略的岗位可以投递，流程结束");
      return;
    }

    // 步骤2：刷新队列并一键准备全部话术
    setMeta("📝 步骤2/4：生成投递话术...");
    await loadQueue();

    const preparePayload = await requestJSON("/api/delivery/queue/prepare-all", {
      method: "POST",
      body: JSON.stringify({
        resumeId: "",
        mode: deliveryStrategy.defaultChatMode || "积极主动",
        limit: deliveryStrategy.batchPrepareLimit || 20
      })
    });

    const preparedCount = (preparePayload.items || []).length;
    setMeta("✅ 步骤2/4：已生成 " + preparedCount + " 条话术");

    if (preparedCount === 0) {
      setMeta("⚠️ 没有可投递的岗位（话术生成失败），流程结束");
      return;
    }

    // 步骤3：刷新队列
    await loadQueue();
    setMeta("🚀 步骤3/4：开始批量投递 " + preparedCount + " 个岗位...");

    // 步骤4：通过 background 批量自动发送
    const sendResult = await new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({
        type: "batchAutoSendAll",
        config: { waitBetweenMs: 1500 }
      }, function(response) {
        if (response && response.ok) {
          resolve(response);
        } else {
          reject(new Error((response && response.error) || "批量发送失败"));
        }
      });
    });

    // 刷新最终状态
    await loadQueue();

    const finalMessage = "🎉 全流程完成：扫描 " + (scanResult.totalJobsFound || 0) +
      " 个 → 生成 " + preparedCount + " 条话术 → 成功发送 " + (sendResult.totalSent || 0) +
      " 个（跳过 " + (sendResult.totalSkipped || 0) + " 个）";
    setMeta(finalMessage);
    console.log("[JobCopilot] " + finalMessage);

  } catch (error) {
    setMeta("❌ 全流程失败: " + (error.message || "未知错误"));
    console.error("[JobCopilot] 全流程失败:", error.message);
  } finally {
    fullPipelineRunning = false;
    if (pipelineBtn) {
      pipelineBtn.disabled = false;
      pipelineBtn.textContent = "⚡ 一键全流程（扫描+投递）";
    }
  }
}

// ========== 自动发送简历开关 ==========

// 功能目的：切换自动发送简历开关；实现原因：用户可选择是否让系统在 HR 索要简历时自动发送。
function toggleAutoSendResume() {
  var checkbox = document.getElementById("autoSendResumeCheckbox");
  var enabled = checkbox ? checkbox.checked : false;
  safePopupStorageSet({ autoSendResume: enabled }, function(error) {
    if (error) {
      setMeta("扩展存储空间不足，已清理临时数据后仍无法保存开关");
      return;
    }
    setMeta(enabled ? "已开启：HR索要简历时将自动发送 BOSS 第一个简历" : "已关闭：HR索要简历时不会自动发送");
  });
}

function safePopupStorageSet(payload, done) {
  chrome.storage.local.set(payload, function() {
    var firstError = chrome.runtime.lastError;
    if (!firstError) {
      done(null);
      return;
    }

    var message = String(firstError.message || "").toLowerCase();
    if (message.indexOf("quota") === -1 && message.indexOf("kquotabytes") === -1) {
      done(firstError);
      return;
    }

    chrome.storage.local.get(null, function(items) {
      var removeKeys = [];
      Object.keys(items || {}).forEach(function(key) {
        if (key.indexOf("jobCopilotBridge") === 0 || key === "jobCopilotLastBackgroundMessage") {
          removeKeys.push(key);
        }
      });
      if (!removeKeys.length) {
        done(firstError);
        return;
      }

      chrome.storage.local.remove(removeKeys, function() {
        chrome.storage.local.set(payload, function() {
          done(chrome.runtime.lastError || null);
        });
      });
    });
  });
}

const state = {
  projects: [],
  resumes: [],
  jobs: [],
  queueItems: [],
  queueStats: { total: 0, statusCounts: {}, nextItemId: "" },
  dashboardStats: null,
  currentJob: null,
  currentResume: null,
  deliveryStrategy: null,
  aiReplySettings: null
};

const apiBase = "";
const singlePageMode = document.body.classList.contains("single-page-mode");
const DEFAULT_TARGET_ROLE = "golang后端";
const DEFAULT_MIN_SALARY_K = 25;
const FIXED_TARGET_CITY = "深圳市";

window.jobCopilotAppLoaded = true;
setDebugStatus("前端脚本已加载");

// 功能目的：绑定导航事件；实现原因：单页应用不需要额外路由依赖。
document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

// 功能目的：集中绑定按钮事件；实现原因：避免 HTML 内联脚本分散业务逻辑。
bindClick("refreshDashboard", refreshDashboard);
bindClick("scanProjectsButton", scanProjects);
bindClick("generateResumeButton", generateResume);
bindClick("analyzeJobButton", analyzeJob);
bindClick("tailorResumeButton", tailorResume);
bindClick("suggestChatButton", suggestChat);
bindClick("sandboxButton", runSandbox);
bindClick("saveFeedbackButton", saveFeedback);
bindClick("saveStrategyButton", saveStrategy);
bindClick("refreshJobsButton", refreshJobs);
bindClick("oneClickScanButton", startOneClickScan);
bindClick("oneClickFullPipelineButton", startOneClickFullPipeline);
bindClick("openBossJobsButton", openBossJobsPage);
bindClick("enqueueAllJobsButton", enqueueAllJobs);
bindClick("prepareQueueButton", prepareQueue);
bindClick("fillNextQueueButton", fillNextQueueItem);
bindClick("refreshQueueButton", loadQueue);
bindClick("autoChatNextButton", autoChatNextQueueItem);
bindClick("batchAutoSendAllButton", batchAutoSendAll);
bindClick("refreshAutoStatusButton", refreshAutoStatus);
bindClick("saveAutoConfigButton", saveAutoConfig);

const aiReplyProviderInput = document.getElementById("aiReplyProvider");
if (aiReplyProviderInput) {
  aiReplyProviderInput.addEventListener("change", toggleAIReplyProviderSettings);
}

if (singlePageMode) {
  activateAllViews();
}

loadInitialData();

function bindClick(elementId, handler) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }
  element.addEventListener("click", async () => {
    try {
      setDebugStatus(`触发操作：${element.textContent.trim()}`);
      await handler();
    } catch (error) {
      setDebugStatus(error.message || "操作失败");
      showToast(error.message || "操作失败");
    }
  });
}

// 功能目的：切换页面视图；实现原因：保持首屏简单且减少重复页面文件。
function switchView(viewId) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewId);
  });
  if (singlePageMode) {
    activateAllViews();
    expandSectionPanels(viewId);
    const targetView = document.getElementById(viewId);
    if (targetView) {
      targetView.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === viewId);
  });
}

// 功能目的：保持所有区域常驻显示；实现原因：单页无障碍模式不应要求用户反复切换标签页。
function activateAllViews() {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.add("active");
  });
}

// 功能目的：在单页模式下展开目标区块；实现原因：导航跳转后不应让用户继续手动展开详细内容。
function expandSectionPanels(viewId) {
  const view = document.getElementById(viewId);
  if (!view) {
    return;
  }
  view.querySelectorAll("details.fold-panel").forEach((panel) => {
    panel.open = true;
  });
}

// 功能目的：通知无障碍引导层刷新；实现原因：侧边建议区需要跟随页面数据同步变化。
function notifyAppStateChanged() {
  document.dispatchEvent(new CustomEvent("jobCopilotDataChanged"));
}

async function loadInitialData() {
  const loadResults = await Promise.allSettled([loadDashboard(), loadProjects(), loadResumes(), loadJobs(), loadQueue(), loadFeedback(), loadStrategy(), loadAIReplySettings()]);
  const failedResult = loadResults.find((result) => result.status === "rejected");
  if (failedResult) {
    showToast(failedResult.reason.message || "初始化部分数据失败");
  }
}

// 功能目的：统一封装 JSON 请求；实现原因：所有接口都需要一致的错误处理。
async function requestJSON(path, options = {}) {
  const response = await fetch(apiBase + path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  return await parseJSONResponse(response, path);
}

// 功能目的：兜底解析接口响应；实现原因：后端或旧服务返回纯文本时不能把底层 JSON 异常直接暴露给用户。
async function parseJSONResponse(response, path) {
  const responseText = await response.text();
  const trimmedText = String(responseText || "").trim();
  let payload = null;

  if (trimmedText !== "") {
    try {
      payload = JSON.parse(trimmedText);
    } catch (error) {
      throw new Error(buildNonJSONResponseError(path, response.status, trimmedText));
    }
  }

  if (!response.ok) {
    if (payload && typeof payload === "object" && payload.error) {
      throw new Error(payload.error);
    }
    throw new Error(buildNonJSONResponseError(path, response.status, trimmedText));
  }

  return payload;
}

// 功能目的：生成可读错误文案；实现原因：残障用户需要明确知道是接口异常而不是前端操作失败。
function buildNonJSONResponseError(path, statusCode, responseText) {
  const snippet = String(responseText || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (snippet) {
    return `接口返回异常（${statusCode} ${path}）：${snippet}`;
  }
  return `接口返回异常（${statusCode} ${path}）`;
}

async function loadDashboard() {
  try {
    const stats = await requestJSON("/api/dashboard");
    state.dashboardStats = stats;
    document.getElementById("projectCount").textContent = stats.projectCount;
    document.getElementById("resumeCount").textContent = stats.resumeCount;
    document.getElementById("jobCount").textContent = stats.jobCount;
    document.getElementById("queueCount").textContent = stats.queueCount;
    document.getElementById("feedbackCount").textContent = stats.feedbackCount;
    renderStatusCounts(stats.statusCounts || {});
    renderQueueStatusCounts(stats.queueStatuses || {});
    notifyAppStateChanged();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshDashboard() {
  setDebugStatus("正在刷新仪表盘...");
  await Promise.all([loadDashboard(), loadJobs(), loadQueue()]);
  setDebugStatus(`刷新完成：${state.jobs.length} 个岗位`);
  showToast(`已刷新，当前 ${state.jobs.length} 个岗位`);
}

async function refreshJobs() {
  try {
    setDebugStatus("正在刷新岗位...");
    await loadJobs();
    const message = `本地岗位已刷新：${state.jobs.length} 个。抓取新岗位请打开 BOSS 页面，插件会自动同步。`;
    setDebugStatus(message);
    showToast(message);
  } catch (error) {
    setDebugStatus(error.message);
    showToast(error.message);
  }
}

// 功能目的：一键全自动扫描；实现原因：通过插件桥接触发background的完整扫描流程。
async function startOneClickScan() {
  try {
    const btn = document.getElementById("oneClickScanButton");
    if (btn.dataset.scanning === "true") {
      showToast("扫描已在运行中");
      return;
    }
    btn.textContent = "⏳ 扫描中...";
    btn.dataset.scanning = "true";
    btn.style.background = "#f59e0b";
    btn.disabled = true;

    const startedMessage = "一键扫描启动：正在打开BOSS → 翻页 → 抓取 → 入库 → 过滤...";
    setDebugStatus(startedMessage);
    showToast(startedMessage);

    const result = await oneClickScanFromPlugin(readPluginScanConfig());
    await Promise.all([loadJobs(), loadDashboard()]);

    const message = `一键扫描完成：抓取 ${result.totalJobsFound} 个岗位（${result.totalPagesScrolled} 页），建议投递 ${result.totalInQueue} 个，过滤 ${result.totalBlocked} 个，耗时 ${result.elapsedSeconds} 秒`;
    setDebugStatus(message);
    showToast(message);
  } catch (error) {
    setDebugStatus(error.message);
    showToast(error.message);
  } finally {
    const btn = document.getElementById("oneClickScanButton");
    btn.textContent = "一键全自动扫描";
    btn.dataset.scanning = "false";
    btn.style.background = "#dc2626";
    btn.disabled = false;
  }
}

function oneClickScanFromPlugin(scanConfig = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `scan_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleResult);
      reject(new Error("专用 Edge 还没有完成一键扫描接管。请保持专用 Edge 打开，系统连接后会自动继续。"));
    }, 900000);

    function handleResult(event) {
      if (event.source !== window || !event.data || event.data.type !== "jobCopilotOneClickScanResult") {
        return;
      }
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleResult);
      if (!event.data.ok) {
        reject(new Error(event.data.error || "一键扫描失败"));
        return;
      }
      resolve(event.data);
    }

    window.addEventListener("message", handleResult);
    window.postMessage({
      type: "jobCopilotOneClickScan",
      requestId: requestId,
      maxPages: scanConfig.maxPages || 100,
      scrollDelay: scanConfig.scrollDelay || 1200,
      minScore: scanConfig.minScore || 0,
      keyword: scanConfig.keyword || DEFAULT_TARGET_ROLE,
      city: scanConfig.city || FIXED_TARGET_CITY
    }, window.location.origin);
  });
}

// 功能目的：触发插件自动拉取 BOSS 岗位；实现原因：系统页无法直接读取 BOSS DOM，必须由浏览器插件执行抓取。
async function openBossJobsPage() {
  try {
    const startedMessage = "正在通过插件打开 BOSS 并拉取岗位...";
    setDebugStatus(startedMessage);
    showToast(startedMessage);
    const result = await pullBossJobsFromPlugin(readPluginScanConfig());
    await Promise.all([loadJobs(), loadDashboard()]);
    const jobCount = result && Number.isFinite(result.jobCount) ? result.jobCount : 0;
    const message = `自动拉取完成：本次识别 ${jobCount} 个岗位，本地库 ${state.jobs.length} 个`;
    setDebugStatus(message);
    showToast(message);
  } catch (error) {
    const fallbackMessage = `${error.message || "插件拉取失败"}。已打开 BOSS 岗位页，请确认插件已加载。`;
    window.open("https://www.zhipin.com/web/geek/jobs", "_blank", "noopener");
    setDebugStatus(fallbackMessage);
    showToast(fallbackMessage);
  }
}

// 功能目的：调用系统页插件桥接；实现原因：localhost 页面只能通过 content script 间接访问 background。
function pullBossJobsFromPlugin(scanConfig = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `pull_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleResult);
      reject(new Error("专用 Edge 还没有接管自动拉取。请保持专用 Edge 打开后稍等重试。"));
    }, 900000);

    function handleResult(event) {
      if (event.source !== window || !event.data || event.data.type !== "jobCopilotPullJobsResult") {
        return;
      }
      if (event.data.requestId !== requestId) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleResult);
      if (!event.data.ok) {
        reject(new Error(event.data.error || "插件自动拉取失败"));
        return;
      }
      resolve(event.data.payload || {});
    }

    window.addEventListener("message", handleResult);
    window.postMessage({
      type: "jobCopilotPullJobs",
      requestId,
      maxScrolls: 100,
      scrollDelay: 1200,
      minScore: scanConfig.minScore || 0,
      keyword: scanConfig.keyword || DEFAULT_TARGET_ROLE,
      city: scanConfig.city || FIXED_TARGET_CITY
    }, window.location.origin);
  });
}

// 功能目的：读取插件扫描条件；实现原因：一键流程必须遵守页面上的岗位、城市和匹配分筛选。
function readPluginScanConfig() {
  const strategy = state.deliveryStrategy || {};
  return {
    maxPages: 100,
    scrollDelay: 1200,
    minScore: readOptionalNumber("strategyMinScoreInput", strategy.minMatchScore || 0, 0, 100),
    keyword: readTargetRole(),
    city: FIXED_TARGET_CITY
  };
}

function readTargetRole() {
  const strategy = state.deliveryStrategy || {};
  return readFirstNonEmptyInput(
    ["accessibleTargetRole", "strategyIncludeTitleInput"],
    [strategy.includeTitleKeywords && strategy.includeTitleKeywords[0], DEFAULT_TARGET_ROLE]
  );
}

// 功能目的：安全读取可选数字控件；实现原因：首屏和折叠区控件可能未填写但不能中断扫描。
function readOptionalNumber(elementId, defaultValue, minValue, maxValue) {
  const element = document.getElementById(elementId);
  const parsedValue = Number.parseInt(element ? element.value : "", 10);
  if (Number.isNaN(parsedValue)) {
    return defaultValue;
  }
  return Math.max(minValue, Math.min(maxValue, parsedValue));
}

// 功能目的：按优先级读取搜索文本；实现原因：无障碍首屏和高级表单都可能提供目标岗位。
function readFirstNonEmptyInput(elementIds, fallbackValues) {
  for (const elementId of elementIds) {
    const element = document.getElementById(elementId);
    const value = cleanBridgeText(element ? element.value : "", 60);
    if (value) {
      return value;
    }
  }
  for (const fallbackValue of fallbackValues || []) {
    const cleanedFallback = cleanBridgeText(fallbackValue, 60);
    if (cleanedFallback) {
      return cleanedFallback;
    }
  }
  return DEFAULT_TARGET_ROLE;
}

function cleanBridgeText(value, maxLength) {
  return String(value || "").trim().slice(0, Math.max(0, maxLength || 0));
}

// 功能目的：统一调用系统页插件桥；实现原因：Web 页面不能直接访问 chrome.runtime。
function requestPluginBridge(requestType, resultType, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = requestType + "_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleResult);
      reject(new Error("专用 Edge 还没有接管当前动作。请保持专用 Edge 打开，系统连接后会自动继续。"));
    }, timeoutMs || 20000);

    function handleResult(event) {
      if (event.source !== window || !event.data || event.data.type !== resultType) {
        return;
      }
      if (event.data.requestId !== requestId) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleResult);
      if (event.data.ok === false) {
        reject(new Error(event.data.error || "插件操作失败"));
        return;
      }
      resolve(event.data);
    }

    window.addEventListener("message", handleResult);
    window.postMessage({
      type: requestType,
      requestId,
      ...(payload || {})
    }, window.location.origin);
  });
}

async function loadProjects() {
  const payload = await requestJSON("/api/projects");
  state.projects = payload.projects || [];
  renderProjects();
  notifyAppStateChanged();
}

async function loadResumes() {
  const payload = await requestJSON("/api/resumes");
  state.resumes = payload.resumes || [];
  state.currentResume = state.resumes[state.resumes.length - 1] || null;
  if (state.currentResume) {
    document.getElementById("resumePreview").textContent = state.currentResume.markdown;
  }
  notifyAppStateChanged();
}

async function loadJobs() {
  const payload = await requestJSON("/api/jobs");
  state.jobs = payload.jobs || [];
  renderCapturedJobs();
  renderRecentJobs();
  notifyAppStateChanged();
}

async function loadQueue() {
  const payload = await requestJSON("/api/delivery/queue");
  state.queueItems = payload.items || [];
  state.queueStats = payload.stats || { total: state.queueItems.length, statusCounts: {}, nextItemId: "" };
  renderDeliveryQueue();
  renderQueueProgress();
  notifyAppStateChanged();
}

async function loadStrategy() {
  const payload = await requestJSON("/api/delivery/strategy");
  state.deliveryStrategy = payload.strategy;
  renderStrategy(payload.strategy);
  notifyAppStateChanged();
}

async function saveStrategy() {
  try {
    setDebugStatus("正在保存策略...");
    const payload = await requestJSON("/api/delivery/strategy", {
      method: "POST",
      body: JSON.stringify(readStrategy())
    });
    state.deliveryStrategy = payload.strategy;
    renderStrategy(payload.strategy);
    notifyAppStateChanged();
    setDebugStatus("投递策略已保存");
    showToast("投递策略已保存");
  } catch (error) {
    setDebugStatus(error.message);
    showToast(error.message);
  }
}

async function scanProjects() {
  try {
    const paths = document.getElementById("projectPathsInput").value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const payload = await requestJSON("/api/projects/scan", {
      method: "POST",
      body: JSON.stringify({ paths })
    });
    state.projects = payload.projects || [];
    renderProjects();
    await loadDashboard();
    showToast("项目扫描完成");
  } catch (error) {
    showToast(error.message);
  }
}

async function generateResume() {
  try {
    const profile = readProfile();
    const payload = await requestJSON("/api/resumes/generate", {
      method: "POST",
      body: JSON.stringify({
        profile,
        projectIds: state.projects.map((project) => project.id)
      })
    });
    state.currentResume = payload.resume;
    document.getElementById("resumePreview").textContent = payload.resume.markdown;
    await loadDashboard();
    showToast("基础简历已生成");
  } catch (error) {
    showToast(error.message);
  }
}

async function analyzeJob() {
  try {
    const profile = readProfile();
    const payload = await requestJSON("/api/jobs/analyze", {
      method: "POST",
      body: JSON.stringify({
        title: document.getElementById("jobTitleInput").value,
        company: document.getElementById("companyInput").value,
        description: document.getElementById("jobDescriptionInput").value,
        candidateSkills: profile.skills
      })
    });
    state.currentJob = payload.job;
    renderJobAnalysis(payload.job);
    await Promise.all([loadDashboard(), loadJobs()]);
    showToast("岗位分析完成");
  } catch (error) {
    showToast(error.message);
  }
}

async function tailorResume() {
  try {
    if (!state.currentJob) {
      throw new Error("请先分析岗位");
    }
    const payload = await requestJSON("/api/resumes/tailor", {
      method: "POST",
      body: JSON.stringify({
        profile: readProfile(),
        projectIds: state.projects.map((project) => project.id),
        jobId: state.currentJob.id
      })
    });
    state.currentResume = payload.resume;
    document.getElementById("resumePreview").textContent = payload.resume.markdown;
    switchView("profile");
    await loadDashboard();
    showToast("定制简历已生成");
  } catch (error) {
    showToast(error.message);
  }
}

async function suggestChat() {
  try {
    if (!state.currentJob) {
      throw new Error("请先分析岗位");
    }
    const payload = await requestJSON("/api/chat/suggest", {
      method: "POST",
      body: JSON.stringify({
        jobId: state.currentJob.id,
        resumeId: state.currentResume ? state.currentResume.id : "",
        messages: [],
        mode: document.getElementById("chatModeInput").value
      })
    });
    document.getElementById("chatSuggestionOutput").value = payload.suggestion.recommendedReply;
    showToast("话术已生成");
  } catch (error) {
    showToast(error.message);
  }
}

async function runSandbox() {
  try {
    if (!state.currentJob) {
      throw new Error("请先分析岗位");
    }
    const payload = await requestJSON("/api/chat/sandbox/auto", {
      method: "POST",
      body: JSON.stringify({
        jobId: state.currentJob.id,
        resumeId: state.currentResume ? state.currentResume.id : "",
        rounds: 3
      })
    });
    renderSandbox(payload.messages || []);
  } catch (error) {
    showToast(error.message);
  }
}

async function enqueueAllJobs() {
  if (state.jobs.length === 0) {
    throw new Error("没有已抓取岗位");
  }

  const payload = await requestJSON("/api/delivery/queue/add", {
    method: "POST",
    body: JSON.stringify({
      jobs: state.jobs.map(jobToVisibleJob),
      candidateSkills: readProfile().skills,
      minScore: readNumber("strategyMinScoreInput", 75, 1, 100),
      includeAll: true
    })
  });
  await Promise.all([loadQueue(), loadDashboard()]);
  showToast(`已加入队列 ${payload.items.length} 个岗位`);
}

async function prepareQueue() {
  const payload = await requestJSON("/api/delivery/queue/prepare-all", {
    method: "POST",
    body: JSON.stringify({
      resumeId: state.currentResume ? state.currentResume.id : "",
      mode: document.getElementById("strategyChatModeInput").value,
      limit: readNumber("strategyBatchLimitInput", 10, 1, 20)
    })
  });
  await Promise.all([loadQueue(), loadDashboard()]);
  showToast(`已生成 ${payload.items.length} 条话术，失败 ${payload.failed.length} 条`);
}

async function fillNextQueueItem() {
  const queueItem = selectNextQueueItem();
  if (!queueItem) {
    throw new Error("没有待处理队列");
  }
  await requestQueueFill(queueItem.id);
}

async function requestQueueFill(queueItemID) {
  const payload = await requestJSON("/api/delivery/queue/fill-request", {
    method: "POST",
    body: JSON.stringify({
      queueItemId: queueItemID,
      resumeId: state.currentResume ? state.currentResume.id : "",
      mode: document.getElementById("strategyChatModeInput").value
    })
  });
  await Promise.all([loadQueue(), loadDashboard()]);
  if (payload.item && payload.item.url) {
    window.open(buildFillTaskURL(payload.item.url, payload.task.queueItemId), "_blank", "noopener");
  }
  showToast("已打开 BOSS，进入沟通输入框后会自动填入话术");
}

async function updateQueueItemStatus(queueItemID, status) {
  await requestJSON("/api/delivery/queue/status", {
    method: "POST",
    body: JSON.stringify({
      queueItemId: queueItemID,
      status,
      notes: status === "delivered" ? "用户已在 BOSS 页面手动发送" : ""
    })
  });
  await Promise.all([loadQueue(), loadDashboard(), loadFeedback()]);
  showToast(queueStatusLabel(status));
}

async function copyQueueDraft(queueItemID) {
  const queueItem = state.queueItems.find((item) => item.id === queueItemID);
  if (!queueItem || !queueItem.openingDraft) {
    throw new Error("该岗位还没有生成话术");
  }
  await navigator.clipboard.writeText(queueItem.openingDraft);
  showToast("话术已复制");
}

async function saveFeedback() {
  try {
    await requestJSON("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        jobId: state.currentJob ? state.currentJob.id : "",
        resumeId: state.currentResume ? state.currentResume.id : "",
        company: document.getElementById("feedbackCompanyInput").value,
        status: document.getElementById("feedbackStatusInput").value,
        message: document.getElementById("chatSuggestionOutput").value,
        notes: document.getElementById("feedbackNotesInput").value
      })
    });
    await Promise.all([loadDashboard(), loadFeedback()]);
    showToast("反馈已保存");
  } catch (error) {
    showToast(error.message);
  }
}

async function loadFeedback() {
  const payload = await requestJSON("/api/feedback");
  renderFeedback(payload.feedbacks || []);
}

function renderStrategy(strategy) {
  const includeTitleKeywords = Array.isArray(strategy.includeTitleKeywords) ? strategy.includeTitleKeywords : [];
  const primaryTargetRole = includeTitleKeywords[0] || DEFAULT_TARGET_ROLE;
  document.getElementById("strategyMinScoreInput").value = strategy.minMatchScore;
  document.getElementById("strategyBatchLimitInput").value = strategy.batchPrepareLimit;
  const minSalaryK = Number(strategy.minSalaryK) > 0 ? Number(strategy.minSalaryK) : DEFAULT_MIN_SALARY_K;
  const maxSalaryK = Number(strategy.maxSalaryK) > 0 ? Number(strategy.maxSalaryK) : "";
  document.getElementById("strategyMinSalaryInput").value = minSalaryK;
  document.getElementById("strategyMaxSalaryInput").value = maxSalaryK;
  const accessibleMinSalaryInput = document.getElementById("accessibleMinSalary");
  const accessibleMaxSalaryInput = document.getElementById("accessibleMaxSalary");
  if (accessibleMinSalaryInput) {
    accessibleMinSalaryInput.value = minSalaryK;
  }
  if (accessibleMaxSalaryInput) {
    accessibleMaxSalaryInput.value = maxSalaryK;
  }
  document.getElementById("strategyAllowUnknownSalaryInput").checked = false;
  document.getElementById("strategyChatModeInput").value = strategy.defaultChatMode || "专业稳重";
  document.getElementById("strategyIncludeTitleInput").value = joinKeywords(includeTitleKeywords);
  document.getElementById("strategyExcludeTitleInput").value = joinKeywords(strategy.excludeTitleKeywords);
  document.getElementById("strategyExcludeCompanyInput").value = joinKeywords(strategy.excludeCompanyKeywords);
  document.getElementById("strategyGreetingPromptInput").value = strategy.greetingPrompt || "";
  const accessibleTargetRole = document.getElementById("accessibleTargetRole");
  if (accessibleTargetRole && (!accessibleTargetRole.value.trim() || accessibleTargetRole.value.trim() === DEFAULT_TARGET_ROLE)) {
    accessibleTargetRole.value = primaryTargetRole;
  }
}

function readStrategy() {
  return {
    minMatchScore: readNumber("strategyMinScoreInput", 75, 1, 100),
    batchPrepareLimit: readNumber("strategyBatchLimitInput", 20, 1, 20),
    minSalaryK: readNumber("strategyMinSalaryInput", DEFAULT_MIN_SALARY_K, 0, 300),
    maxSalaryK: readNumber("strategyMaxSalaryInput", 0, 0, 300),
    allowUnknownSalary: false,
    defaultChatMode: document.getElementById("strategyChatModeInput").value,
    includeTitleKeywords: splitKeywords(document.getElementById("strategyIncludeTitleInput").value),
    excludeTitleKeywords: splitKeywords(document.getElementById("strategyExcludeTitleInput").value),
    includeCompanyKeywords: [],
    excludeCompanyKeywords: splitKeywords(document.getElementById("strategyExcludeCompanyInput").value),
    includeDescriptionKeywords: [],
    excludeDescriptionKeywords: [],
    greetingPrompt: document.getElementById("strategyGreetingPromptInput").value.trim()
  };
}

// 功能目的：读取用户事实信息；实现原因：简历生成必须以用户确认内容为准。
function readProfile() {
  return {
    name: document.getElementById("nameInput").value.trim(),
    targetRole: document.getElementById("roleInput").value.trim(),
    yearsExperience: document.getElementById("yearsInput").value.trim(),
    location: document.getElementById("locationInput").value.trim(),
    email: document.getElementById("emailInput").value.trim(),
    phone: document.getElementById("phoneInput").value.trim(),
    education: document.getElementById("educationInput").value.trim(),
    skills: document.getElementById("skillsInput").value
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean)
  };
}

function renderProjects() {
  const container = document.getElementById("projectList");
  container.innerHTML = "";
  state.projects.forEach((project) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.textContent = `${project.name}｜${(project.techStack || []).join("、") || "待识别"}｜${project.path}`;
    container.appendChild(item);
  });
}

function renderCapturedJobs() {
  const container = document.getElementById("capturedJobList");
  if (!container) {
    return;
  }
  renderJobList(container, state.jobs.slice().reverse(), true);
}

function renderRecentJobs() {
  const container = document.getElementById("recentJobList");
  if (!container) {
    return;
  }
  renderJobList(container, state.jobs.slice().reverse().slice(0, 6), false);
}

function renderJobList(container, jobs, withActions) {
  container.innerHTML = "";
  if (jobs.length === 0) {
    const emptyItem = document.createElement("div");
    emptyItem.className = "result-item muted";
    emptyItem.textContent = "还没有抓取岗位。打开 BOSS 职位页，用插件扫描可见岗位后会自动入库。";
    container.appendChild(emptyItem);
    return;
  }

  jobs.forEach((job) => {
    const item = document.createElement("div");
    item.className = "result-item job-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHTML(job.title || "未知岗位")}</strong>
        <p>${escapeHTML(formatJobMeta(job))}</p>
        <p>${escapeHTML(job.recommendation || "")}</p>
      </div>
    `;

    if (withActions) {
      const actionGroup = document.createElement("div");
      actionGroup.className = "item-actions";
      const useButton = document.createElement("button");
      useButton.className = "secondary-button";
      useButton.textContent = "使用";
      useButton.addEventListener("click", () => useCapturedJob(job.id));
      actionGroup.appendChild(useButton);

      if (job.url) {
        const link = document.createElement("a");
        link.className = "text-link";
        link.href = job.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "打开原页";
        actionGroup.appendChild(link);
      }
      item.appendChild(actionGroup);
    }

    container.appendChild(item);
  });
}

function renderDeliveryQueue() {
  const container = document.getElementById("deliveryQueueList");
  if (!container) {
    return;
  }
  container.innerHTML = "";
  if (state.queueItems.length === 0) {
    const emptyItem = document.createElement("div");
    emptyItem.className = "result-item muted";
    emptyItem.textContent = "队列为空";
    container.appendChild(emptyItem);
    return;
  }

  state.queueItems.slice().reverse().forEach((queueItem) => {
    const item = document.createElement("div");
    item.className = "result-item job-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHTML(queueItem.title || "未知岗位")}</strong>
        <p>${escapeHTML(formatQueueMeta(queueItem))}</p>
        <p>${escapeHTML(queueItem.openingDraft || "话术未生成")}</p>
      </div>
    `;

    const actionGroup = document.createElement("div");
    actionGroup.className = "item-actions";
    if (queueItem.url) {
      actionGroup.appendChild(buildSmallButton("打开并填入", () => requestQueueFill(queueItem.id), "primary-button"));
    }
    actionGroup.appendChild(buildSmallButton("复制话术", () => copyQueueDraft(queueItem.id), "secondary-button"));
    actionGroup.appendChild(buildSmallButton("已发送", () => updateQueueItemStatus(queueItem.id, "delivered"), "secondary-button"));
    actionGroup.appendChild(buildSmallButton("跳过", () => updateQueueItemStatus(queueItem.id, "skipped"), "secondary-button"));
    item.appendChild(actionGroup);
    container.appendChild(item);
  });
}

function renderQueueProgress() {
  const container = document.getElementById("deliveryQueueProgress");
  if (!container) {
    return;
  }
  const counts = state.queueStats.statusCounts || {};
  container.innerHTML = "";
  [
    ["总数", state.queueStats.total || 0],
    ["待准备", counts.queued || 0],
    ["已准备", counts.prepared || 0],
    ["已打开", counts.opened || 0],
    ["已填入", counts.filled || 0],
    ["已发送", counts.delivered || 0],
    ["已跳过", (counts.skipped || 0) + (counts.rejected || 0)]
  ].forEach(([label, count]) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${label} ${count}`;
    container.appendChild(tag);
  });
}

function buildSmallButton(text, handler, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", async () => {
    try {
      await handler();
    } catch (error) {
      showToast(error.message || "操作失败");
    }
  });
  return button;
}

function selectNextQueueItem() {
  const queueItemsWithURL = state.queueItems.filter((item) => item.url);
  return queueItemsWithURL.find((item) => item.status === "prepared")
    || queueItemsWithURL.find((item) => item.status === "queued")
    || queueItemsWithURL.find((item) => item.status === "opened")
    || queueItemsWithURL.find((item) => item.status === "filled")
    || queueItemsWithURL.find((item) => !item.status);
}

function useCapturedJob(jobID) {
  const job = state.jobs.find((candidateJob) => candidateJob.id === jobID);
  if (!job) {
    showToast("岗位不存在，请刷新后重试");
    return;
  }

  state.currentJob = job;
  document.getElementById("companyInput").value = job.company || "";
  document.getElementById("jobTitleInput").value = job.title || "";
  document.getElementById("jobDescriptionInput").value = job.description || "";
  renderJobAnalysis(job);
  switchView("job");
  showToast("岗位已载入");
}

function formatJobMeta(job) {
  return [
    job.company || "未知公司",
    job.location || "",
    job.salary || "",
    `匹配度 ${job.matchScore || 0}`
  ].filter(Boolean).join("｜");
}

function formatQueueMeta(queueItem) {
  return [
    queueItem.company || "未知公司",
    queueItem.location || "",
    queueItem.salary || "",
    `匹配度 ${queueItem.matchScore || 0}`,
    queueStatusLabel(queueItem.status)
  ].filter(Boolean).join("｜");
}

function jobToVisibleJob(job) {
  return {
    clientId: job.id,
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    url: job.url || "",
    description: job.description || ""
  };
}

function buildFillTaskURL(rawURL, queueItemID) {
  const url = new URL(rawURL, window.location.href);
  url.hash = `jobCopilotTask=${encodeURIComponent(queueItemID || "")}`;
  return url.toString();
}

function renderJobAnalysis(job) {
  const container = document.getElementById("jobAnalysisResult");
  container.innerHTML = `
    <strong>匹配度：${job.matchScore}</strong>
    <p>${escapeHTML(job.recommendation)}</p>
    <p>关键词：${escapeHTML((job.keywords || []).join("、"))}</p>
    <p>缺口：${escapeHTML((job.missingSkills || []).join("、") || "暂无明显缺口")}</p>
    <p>风险：${escapeHTML((job.risks || []).join("；"))}</p>
  `;
}

function renderSandbox(messages) {
  const container = document.getElementById("sandboxOutput");
  container.innerHTML = "";
  messages.forEach((message) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.textContent = `${message.role === "recruiter" ? "HR" : "候选人"}：${message.content}`;
    container.appendChild(item);
  });
}

function renderFeedback(feedbacks) {
  const container = document.getElementById("feedbackList");
  container.innerHTML = "";
  feedbacks.slice().reverse().forEach((feedback) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.textContent = `${feedback.status}｜${feedback.company || "未知公司"}｜${feedback.notes || "无备注"}`;
    container.appendChild(item);
  });
}

function renderStatusCounts(statusCounts) {
  const container = document.getElementById("statusCounts");
  container.innerHTML = "";
  Object.entries(statusCounts).forEach(([status, count]) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${status} ${count}`;
    container.appendChild(tag);
  });
}

function renderQueueStatusCounts(statusCounts) {
  const container = document.getElementById("queueStatusCounts");
  container.innerHTML = "";
  Object.entries(statusCounts).forEach(([status, count]) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${queueStatusLabel(status)} ${count}`;
    container.appendChild(tag);
  });
}

function queueStatusLabel(status) {
  const labels = {
    queued: "待准备",
    prepared: "已准备",
    opened: "已打开",
    filled: "已填入",
    delivered: "已投递",
    skipped: "已跳过",
    rejected: "不合适"
  };
  return labels[status] || status;
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

function setDebugStatus(message) {
  const status = document.getElementById("debugStatus");
  if (status) {
    status.textContent = message;
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2800);
}

// 功能目的：转义接口返回文本；实现原因：防止岗位内容进入页面时产生脚本注入。
function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ========== 自动聊天 ==========

// 功能目的：自动聊天下一个队列项；实现原因：一键启动自动对话流程。
async function autoChatNextQueueItem() {
  try {
    const queueItem = selectNextQueueItem();
    if (!queueItem) {
      throw new Error("没有待处理队列");
    }

    // 确保有话术
    let item = queueItem;
    if (!item.openingDraft) {
      const payload = await requestJSON("/api/delivery/queue/prepare", {
        method: "POST",
        body: JSON.stringify({
          queueItemId: item.id,
          resumeId: state.currentResume ? state.currentResume.id : "",
          mode: (state.deliveryStrategy && state.deliveryStrategy.defaultChatMode) || "积极主动"
        })
      });
      item = payload.item;
    }

    if (!item.openingDraft) {
      throw new Error("无法生成话术");
    }

    if (!item.url) {
      throw new Error("该岗位缺少 BOSS 链接");
    }

    // 更新状态为 opened
    await requestJSON("/api/delivery/queue/status", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: item.id,
        status: "opened",
        notes: ""
      })
    });

    // 打开 BOSS 页面，通过 URL 参数传递自动聊天指令
    const autoChatUrl = buildAutoChatURL(item);
    window.open(autoChatUrl, "_blank", "noopener");

    setDebugStatus(`自动聊天已启动: ${item.company} - ${item.title}`);
    showToast("已打开 BOSS 页面，插件将自动开始对话。请在插件弹窗中查看进度。");
    await Promise.all([loadQueue(), loadDashboard()]);
  } catch (error) {
    setDebugStatus(error.message);
    showToast(error.message);
  }
}

// 功能目的：构建带自动聊天参数的URL；实现原因：让 content script 识别并启动自动聊天。
function buildAutoChatURL(queueItem) {
  var url = new URL(queueItem.url, window.location.href);
  var params = {
    autoChat: "1",
    queueItemId: queueItem.id,
    jobId: queueItem.jobId,
    draft: encodeURIComponent(queueItem.openingDraft || ""),
    mode: (state.deliveryStrategy && state.deliveryStrategy.defaultChatMode) || "积极主动"
  };
  url.hash = Object.keys(params).map(function(k) { return k + "=" + params[k]; }).join("&");
  return url.toString();
}

// 功能目的：批量全部自动发送；实现原因：遍历所有待处理队列项，逐个打开并自动发送开场白。
var batchAutoRunning = false;
var batchAutoStop = false;

// 功能目的：批量全部自动发送；实现原因：通过插件bridge调用background后台逐个打开→填入→发送→标记
async function batchAutoSendAll() {
  if (batchAutoRunning) {
    batchAutoStop = true;
    showToast("正在停止批量发送...");
    return;
  }

  batchAutoRunning = true;
  batchAutoStop = false;

  try {
    setDebugStatus("批量发送启动：通过插件后台逐个投递...");
    showToast("批量发送启动：插件将在后台逐个打开岗位并发送");

    // 优先通过插件 bridge 调用 background 的批量发送（后台静默执行）
    const result = await batchAutoSendFromPlugin();

    await Promise.all([loadQueue(), loadDashboard()]);
    const message = "批量发送完成：成功 " + (result.totalSent || 0) + " 个，跳过 " + (result.totalSkipped || 0) + " 个";
    setDebugStatus(message);
    showToast(message);
  } catch (error) {
    // 如果插件不可用，降级为原来的逐个打开方式
    setDebugStatus("插件批量发送失败，降级为逐个打开... " + (error.message || ""));
    await batchAutoSendFallback();
  } finally {
    batchAutoRunning = false;
    batchAutoStop = false;
  }
}

// 功能目的：通过插件bridge调用批量发送；实现原因：后台静默执行，不弹窗干扰
function batchAutoSendFromPlugin() {
  return new Promise((resolve, reject) => {
    const requestId = "batch_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    const timeout = window.setTimeout(function() {
      window.removeEventListener("message", handleResult);
      reject(new Error("专用 Edge 还没有接管批量发送。请保持专用 Edge 打开后稍等重试。"));
    }, 1800000);

    function handleResult(event) {
      if (event.source !== window || !event.data || event.data.type !== "jobCopilotBatchAutoSendResult") {
        return;
      }
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleResult);
      if (!event.data.ok) {
        reject(new Error(event.data.error || "批量发送失败"));
        return;
      }
      resolve(event.data);
    }

    window.addEventListener("message", handleResult);
    window.postMessage({
      type: "jobCopilotBatchAutoSend",
      requestId: requestId,
      waitBetweenMs: 1500
    }, window.location.origin);
  });
}

// 功能目的：降级批量发送；实现原因：当插件bridge不可用时，逐个打开BOSS页面发送
async function batchAutoSendFallback() {
  await loadQueue();
  var items = state.queueItems.filter(function(item) {
    return item.status === "prepared" || item.status === "queued" || item.status === "opened";
  });

  if (items.length === 0) {
    showToast("没有待处理的岗位");
    return;
  }

  setDebugStatus("降级批量发送开始，共 " + items.length + " 个岗位...");

  var totalSent = 0;
  var totalSkipped = 0;

  for (var i = 0; i < items.length; i++) {
    if (batchAutoStop) {
      setDebugStatus("批量发送已停止，已完成 " + totalSent + " 个");
      break;
    }

    var item = items[i];
    if (!item.url) {
      totalSkipped++;
      continue;
    }

    if (!item.openingDraft) {
      try {
        var prepPayload = await requestJSON("/api/delivery/queue/prepare", {
          method: "POST",
          body: JSON.stringify({
            queueItemId: item.id,
            resumeId: state.currentResume ? state.currentResume.id : "",
            mode: (state.deliveryStrategy && state.deliveryStrategy.defaultChatMode) || "积极主动"
          })
        });
        item = prepPayload.item;
      } catch (e) {
        totalSkipped++;
        continue;
      }
    }
    if (!item.openingDraft) {
      totalSkipped++;
      continue;
    }

    setDebugStatus("正在处理 " + (i + 1) + "/" + items.length + "：" + (item.company || "未知公司") + " " + (item.title || ""));

    try {
      var fillPayload = await requestJSON("/api/delivery/queue/fill-request", {
        method: "POST",
        body: JSON.stringify({
          queueItemId: item.id,
          resumeId: state.currentResume ? state.currentResume.id : "",
          mode: (state.deliveryStrategy && state.deliveryStrategy.defaultChatMode) || "积极主动"
        })
      });

      if (fillPayload.item && fillPayload.item.url) {
        var fillUrl = buildFillTaskURL(fillPayload.item.url, fillPayload.task.queueItemId);
        window.open(fillUrl, "_blank", "noopener");
      }

      await requestJSON("/api/delivery/queue/status", {
        method: "POST",
        body: JSON.stringify({
          queueItemId: item.id,
          status: "delivered",
          notes: "批量自动发送"
        })
      });

      totalSent++;
      await new Promise(function(resolve) { setTimeout(resolve, 3000); });
    } catch (e) {
      totalSkipped++;
    }
  }

  await Promise.all([loadQueue(), loadDashboard()]);
  setDebugStatus("降级批量发送完成：成功 " + totalSent + " 个，跳过 " + totalSkipped + " 个");
  showToast("降级批量发送完成：成功 " + totalSent + " 个，跳过 " + totalSkipped + " 个");
}

// ========== 全自动模式 - 自动运行，仅监控 ==========

var fullAutoPollingTimer = null;

// 功能目的：页面加载后自动开始轮询全自动状态。
(function startAutoMonitor() {
  fullAutoPollingTimer = window.setInterval(pollFullAutoStatus, 5000);
  // 立即刷新一次
  window.setTimeout(pollFullAutoStatus, 1000);
})();

// 功能目的：保存全自动配置到插件。
async function saveAutoConfig() {
  try {
    const scanInterval = readOptionalNumber("autoScanInterval", 1, 1, 60);
    const maxRounds = readOptionalNumber("autoMaxRounds", 10, 1, 20);
    const minScore = readOptionalNumber("autoMinScore", 50, 1, 100);
    await saveAIReplySettings();
    const automationSnapshot = await requestJSON("/api/automation/status");
    const currentControl = automationSnapshot && automationSnapshot.control ? automationSnapshot.control : {};
    const result = await requestJSON("/api/automation/control", {
      method: "POST",
      body: JSON.stringify({
        enabled: currentControl.enabled === true,
        resumeId: currentControl.resumeId || "",
        keyword: readTargetRole(),
        city: FIXED_TARGET_CITY,
        chatMode: currentControl.chatMode || "积极主动",
        scanIntervalMinutes: scanInterval,
        maxChatRounds: maxRounds,
        maxJobsPerScan: currentControl.maxJobsPerScan || 50,
        minMatchScore: minScore,
        launchBrowser: false
      })
    });

    renderFullAutoState(result.status, result.control);
    showToast("全自动配置已保存（扫描间隔" + scanInterval + "分钟，最低" + minScore + "分）");
  } catch (error) {
    showToast("保存配置失败: " + (error.message || ""));
  }
}

async function refreshAutoStatus() {
  await Promise.all([pollFullAutoStatus(), loadAIReplySettings()]);
}

// 功能目的：显示模型真实可用状态；实现原因：仅检测到 Codex 命令不代表当前已登录可调用。
async function loadAIReplySettings() {
  const result = await requestJSON("/api/ai/reply-settings");
  state.aiReplySettings = result;
  renderAIReplySettings(result);
}

async function saveAIReplySettings() {
  const provider = document.getElementById("aiReplyProvider").value;
  const deepSeekModel = document.getElementById("deepSeekModel").value;
  const deepSeekAPIKey = document.getElementById("deepSeekApiKey").value.trim();
  const zhipuModel = document.getElementById("zhipuModel").value;
  const zhipuAPIKey = document.getElementById("zhipuApiKey").value.trim();
  const status = document.getElementById("aiReplyStatus");
  if (status) {
    status.textContent = "正在保存回复模型设置...";
  }
  const result = await requestJSON("/api/ai/reply-settings", {
    method: "POST",
    body: JSON.stringify({
      provider,
      deepSeekModel,
      deepSeekApiKey: deepSeekAPIKey,
      zhipuModel,
      zhipuApiKey: zhipuAPIKey
    })
  });
  document.getElementById("deepSeekApiKey").value = "";
  document.getElementById("zhipuApiKey").value = "";
  state.aiReplySettings = result;
  renderAIReplySettings(result);
  return result;
}

function renderAIReplySettings(result) {
  const settings = result && result.settings ? result.settings : {};
  const codex = result && result.codex ? result.codex : {};
  const providerInput = document.getElementById("aiReplyProvider");
  const deepSeekModelInput = document.getElementById("deepSeekModel");
  const zhipuModelInput = document.getElementById("zhipuModel");
  if (providerInput) {
    providerInput.value = settings.provider || "codex";
  }
  if (deepSeekModelInput) {
    deepSeekModelInput.value = settings.deepSeekModel || "deepseek-v4-flash";
  }
  if (zhipuModelInput) {
    zhipuModelInput.value = settings.zhipuModel || "glm-4.7-flash";
  }
  toggleAIReplyProviderSettings();

  const status = document.getElementById("aiReplyStatus");
  if (!status) {
    return;
  }
  const providerStatus = settings.provider === "deepseek"
    ? (settings.deepSeekApiKeyConfigured ? "当前选择 DeepSeek，API Key 已配置" : "当前选择 DeepSeek，但尚未配置 API Key")
    : (settings.provider === "zhipu"
      ? (settings.zhipuApiKeyConfigured ? "当前选择智谱 GLM，API Key 已配置" : "当前选择智谱 GLM，但尚未配置 API Key")
      : "当前选择本地 Codex；" + (codex.message || "Codex 状态未知"));
  status.textContent = providerStatus + "。";
}

function toggleAIReplyProviderSettings() {
  const providerInput = document.getElementById("aiReplyProvider");
  const deepSeekSettings = document.getElementById("deepSeekReplySettings");
  const zhipuSettings = document.getElementById("zhipuReplySettings");
  if (!providerInput || !deepSeekSettings || !zhipuSettings) {
    return;
  }
  deepSeekSettings.hidden = providerInput.value !== "deepseek";
  zhipuSettings.hidden = providerInput.value !== "zhipu";
}

// 功能目的：轮询全自动状态；实现原因：系统页不应依赖当前标签页注入扩展，也要能看到专用 Edge 的真实执行状态。
async function pollFullAutoStatus() {
  try {
    const result = await requestJSON("/api/automation/status");
    renderFullAutoState(result.status, result.control);
  } catch (error) {
    updateFullAutoStatus("等待扩展连接", error.message || "插件状态不可用", "0", "0", "-", "-");
  }
}

function updateFullAutoStatus(status, phase, scanned, chatted, lastScan, lastChat) {
  var el = document.getElementById("fullAutoStatus");
  if (!el) return;
  el.innerHTML = [
    "<strong>状态：</strong>" + escapeHTML(status),
    "<strong>阶段：</strong>" + escapeHTML(phase),
    "<strong>已扫描：</strong>" + escapeHTML(scanned) + " 岗位",
    "<strong>已聊天：</strong>" + escapeHTML(chatted) + " 次",
    "<strong>上次扫描：</strong>" + escapeHTML(lastScan || "-"),
    "<strong>上次聊天：</strong>" + escapeHTML(lastChat || "-")
  ].join("<br>");
  el.style.background = "#eef2ff";
}

// 功能目的：渲染插件自动模式状态；实现原因：运行中、停止和等待专用 Edge 接管必须能被用户一眼区分。
function renderFullAutoState(autoState, controlState) {
  const stateValue = autoState || {};
  const controlValue = controlState || {};
  const connected = stateValue.bridgeConnected === true;
  const enabled = connected && stateValue.enabled === true;
  const waitingBrowser = controlValue.enabled === true && !connected;
  updateFullAutoStatus(
    enabled ? "自动运行中" : (waitingBrowser ? "等待专用 Edge 连接" : "未开启"),
    fullAutoPhaseLabel(stateValue.phase),
    String(stateValue.totalProcessed || 0),
    String(stateValue.totalChatted || 0),
    formatAutoModeTime(stateValue.lastScanTime),
    formatAutoModeTime(stateValue.lastChatTime)
  );
}

function fullAutoPhaseLabel(phase) {
  const labels = {
    idle: "继续推进",
    scanning: "扫描岗位",
    enqueuing: "加入队列",
    preparing: "生成话术",
    chatting: "自动投递",
    opening: "打开岗位",
    scrolling: "翻页抓取",
    analyzing: "分析岗位",
    done: "本轮完成",
    error: "异常",
    cancelled: "已停止"
  };
  return labels[phase] || phase || "等待中";
}

function formatAutoModeTime(timestamp) {
  const numericTime = Number(timestamp || 0);
  if (!Number.isFinite(numericTime) || numericTime <= 0) {
    return "-";
  }
  return new Date(numericTime).toLocaleTimeString();
}

// ========== 一键全流程（扫描 → 分析 → 入队 → 准备 → 投递） ==========

var fullPipelineRunning = false;

// 功能目的：一键全流程；实现原因：从扫描到投递全部自动化，通过插件bridge调用
async function startOneClickFullPipeline() {
  if (fullPipelineRunning) {
    showToast("全流程正在运行中，请等待完成...");
    return;
  }

  fullPipelineRunning = true;
  const btn = document.getElementById("oneClickFullPipelineButton");
  if (btn) {
    btn.textContent = "⏳ 全流程运行中...";
    btn.disabled = true;
    btn.style.background = "#f59e0b";
  }

  try {
    // 步骤1：一键扫描
    setDebugStatus("🔍 步骤1/3：一键全自动扫描 BOSS 岗位...");
    showToast("全流程启动：扫描 → 生成话术 → 投递");

    const scanResult = await oneClickScanFromPlugin(readPluginScanConfig());

    const scanMsg = "扫描完成：抓取 " + (scanResult.totalJobsFound || 0) +
      " 个，建议投递 " + (scanResult.totalInQueue || 0) + " 个（已自动入队）";
    setDebugStatus(scanMsg);
    showToast(scanMsg);

    if (!scanResult.totalInQueue) {
      setDebugStatus("⚠️ 没有符合策略的岗位，流程结束");
      return;
    }

    // 步骤2：生成话术
    setDebugStatus("📝 步骤2/3：生成投递话术...");
    const strategy = state.deliveryStrategy || {};
    await requestJSON("/api/delivery/queue/prepare-all", {
      method: "POST",
      body: JSON.stringify({
        resumeId: state.currentResume ? state.currentResume.id : "",
        mode: strategy.defaultChatMode || "积极主动",
        limit: (strategy.batchPrepareLimit || 20)
      })
    });
    await loadQueue();

    // 步骤3：批量发送
    setDebugStatus("🚀 步骤3/3：通过插件后台批量投递...");
    const sendResult = await batchAutoSendFromPlugin();

    await Promise.all([loadQueue(), loadDashboard()]);

    const finalMsg = "🎉 全流程完成：扫描 " + (scanResult.totalJobsFound || 0) +
      " 个 → 成功发送 " + (sendResult.totalSent || 0) +
      " 个（跳过 " + (sendResult.totalSkipped || 0) + " 个）";
    setDebugStatus(finalMsg);
    showToast(finalMsg);

  } catch (error) {
    setDebugStatus("❌ 全流程失败: " + (error.message || ""));
    showToast("全流程失败: " + (error.message || ""));
  } finally {
    fullPipelineRunning = false;
    if (btn) {
      btn.textContent = "一键全流程";
      btn.disabled = false;
      btn.style.background = "#7c3aed";
    }
  }
}

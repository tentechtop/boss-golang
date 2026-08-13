(function installAccessibleAutoApply() {
  const DEFAULT_CHAT_MODE = "积极主动";
  const DEFAULT_SCAN_INTERVAL_MINUTES = 1;
  const DEFAULT_MAX_CHAT_ROUNDS = 10;
  const DEFAULT_TARGET_ROLE = "golang后端";
  const DEFAULT_TARGET_CITY = "深圳市";
  const DEFAULT_MIN_SALARY_K = 25;
  const DEFAULT_MAX_SALARY_K = 0;
  const ALLOWED_RESUME_FILE_EXTENSIONS = [".txt", ".md", ".docx"];
  const QUEUE_PREVIEW_LIMIT = 6;
  const BRIDGE_PREFLIGHT_TIMEOUT_MS = 2500;
  const AUTO_MODE_STATUS_TIMEOUT_MS = 8000;
  const AUTO_MODE_START_TIMEOUT_MS = 45000;
  const accessibleFieldIds = [
    "accessibleTargetRole",
    "accessibleTargetCity",
    "accessibleMinSalary",
    "accessibleMaxSalary",
    "accessibleResumeFile",
    "accessibleResumeText"
  ];

  const accessibleState = {
    running: false,
    pollingTimer: null,
    lastAutoModeState: null,
    startupStartedAt: 0,
    bridgeReady: false,
    automationControl: null,
    automationStatus: null,
    currentQueueItem: null,
    nextQueueItem: null,
    queueItems: null,
    queueStats: null,
    resumeSavePromise: null,
    savedResumeFileKey: ""
  };

  function init() {
    const startButton = document.getElementById("accessibleAutoApplyButton");
    const stopButton = document.getElementById("accessibleStopAutoModeButton");
    const saveAIReplySettingsButton = document.getElementById("accessibleSaveAIReplySettingsButton");
    if (!startButton || !stopButton) {
      return;
    }

    startButton.addEventListener("click", function() {
      runAccessibleAutoApply().catch(function(error) {
        handleAccessibleError(error);
      });
    });
    stopButton.addEventListener("click", function() {
      stopAccessibleAutoMode().catch(function(error) {
        handleAccessibleError(error);
      });
    });
    if (saveAIReplySettingsButton) {
      saveAIReplySettingsButton.addEventListener("click", function() {
        saveAccessibleAIReplySettings(true).catch(function(error) {
          handleAccessibleError(error);
        });
      });
    }

    bindAccessibleFieldListeners();
    window.addEventListener("message", handleAccessibleBridgeEvent);
    document.addEventListener("jobCopilotDataChanged", updateAccessibleDashboard);
    syncAccessibleDefaults();
    startAccessibleStatusPolling();
    updateAccessibleDashboard();
  }

  function syncAccessibleDefaults() {
    const strategy = readCurrentStrategy();
    setInputValue(
      "accessibleTargetRole",
      strategy.includeTitleKeywords && strategy.includeTitleKeywords[0]
        ? strategy.includeTitleKeywords[0]
        : DEFAULT_TARGET_ROLE
    );
    forceInputValue("accessibleTargetCity", DEFAULT_TARGET_CITY);
    const minSalaryK = Number(strategy.minSalaryK) > 0 ? Number(strategy.minSalaryK) : DEFAULT_MIN_SALARY_K;
    const maxSalaryK = Number(strategy.maxSalaryK) > 0 ? Number(strategy.maxSalaryK) : DEFAULT_MAX_SALARY_K;
    forceInputValue("accessibleMinSalary", String(minSalaryK));
    forceInputValue("accessibleMaxSalary", maxSalaryK > 0 ? String(maxSalaryK) : "");
    updateAccessibleDashboard();
  }

  async function runAccessibleAutoApply() {
    if (accessibleState.running) {
      throw new Error("自动投递正在运行，请等待当前任务结束");
    }

    const form = validateAccessibleForm(readAccessibleDraft());
    setAccessibleRunning(true);
    setAccessibleStatus("正在检查简历与投递条件...", "running");

    try {
      await saveAccessibleAIReplySettings(false);
      const resumeVersion = await ensureResumeReady(form);
      const strategy = await saveAccessibleStrategy(form);
      await refreshAccessibleData();

      const pendingQueueItems = listPendingQueueItems(form.targetRole);
      if (pendingQueueItems.length > 0) {
        setAccessibleStatus("检测到待处理岗位，正在继续准备自动投递...", "running");
        await requestJSON("/api/delivery/queue/prepare-all", {
          method: "POST",
          body: JSON.stringify({
            resumeId: resumeVersion ? resumeVersion.id : "",
            mode: DEFAULT_CHAT_MODE,
            limit: Math.min(strategy.batchPrepareLimit || 20, 20)
          })
        });
        await refreshAccessibleData();
      }

      setAccessibleStatus("正在保存自动投递任务，并唤起专用 Edge 自动化...", "running");
      const automationConfig = {
        enabled: true,
        resumeId: resumeVersion ? resumeVersion.id : "",
        keyword: form.targetRole,
        city: DEFAULT_TARGET_CITY,
        chatMode: DEFAULT_CHAT_MODE,
        initialProcessed: 0,
        scanIntervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES,
        maxChatRounds: DEFAULT_MAX_CHAT_ROUNDS,
        maxJobsPerScan: 500,
        minMatchScore: strategy.minMatchScore
      };
      const controlPayload = await saveAccessibleAutomationControl(
        automationConfig,
        shouldLaunchAccessibleBrowser()
      );

      if (accessibleState.bridgeReady) {
        await enableAccessibleAutoMode(automationConfig).catch(function() {
          return null;
        });
      }

      const activeAutomationState = await waitForAccessibleAutomationTakeover(15000).catch(function() {
        return null;
      });
      const automationRunning = !!(activeAutomationState && activeAutomationState.enabled && isAccessibleAutomationConnected());
      const launchErrorText = controlPayload && controlPayload.launchError ? String(controlPayload.launchError) : "";
      const finalMessage = automationRunning
        ? (pendingQueueItems.length > 0
          ? "持续自动投递已开启，系统会从当前队列继续发送开场白并推进下一个岗位。"
          : "持续自动投递已开启，系统会自动找岗、发送开场白并继续下一个岗位。")
        : buildPendingAutomationMessage(launchErrorText);
      setAccessibleStatus(finalMessage, automationRunning ? "success" : (launchErrorText ? "warning" : "running"));
      safeToast(finalMessage);
    } finally {
      setAccessibleRunning(false);
      await refreshAccessibleData();
    }
  }

  async function saveAccessibleAIReplySettings(notifyUser) {
    if (typeof saveAIReplySettings !== "function") {
      throw new Error("AI 回复设置功能尚未加载，请刷新页面后重试");
    }
    const result = await saveAIReplySettings();
    if (notifyUser) {
      const settings = result && result.settings ? result.settings : {};
      const message = settings.provider === "deepseek"
        ? "DeepSeek 自动回复设置已保存"
        : (settings.provider === "zhipu" ? "智谱 GLM 自动回复设置已保存" : "本地 Codex 自动回复设置已保存");
      setAccessibleStatus(message, "success");
      safeToast(message);
    }
    return result;
  }

  async function stopAccessibleAutoMode() {
    setAccessibleStatus("正在停止持续自动投递...", "running");
    const currentControl = accessibleState.automationControl || {};
    await saveAccessibleAutomationControl({
      enabled: false,
      resumeId: currentControl.resumeId || "",
      keyword: currentControl.keyword || readInputValue("accessibleTargetRole").trim() || DEFAULT_TARGET_ROLE,
      city: DEFAULT_TARGET_CITY,
      chatMode: currentControl.chatMode || DEFAULT_CHAT_MODE,
      scanIntervalMinutes: currentControl.scanIntervalMinutes || DEFAULT_SCAN_INTERVAL_MINUTES,
      maxChatRounds: currentControl.maxChatRounds || DEFAULT_MAX_CHAT_ROUNDS,
      maxJobsPerScan: currentControl.maxJobsPerScan || 500,
      minMatchScore: currentControl.minMatchScore || readNumberValue("strategyMinScoreInput", 75, 1, 100)
    }, false);

    if (accessibleState.bridgeReady) {
      await bridgeRequest(
        "jobCopilotSetAutoMode",
        "jobCopilotSetAutoModeResult",
        { config: { enabled: false } },
        15000
      ).catch(function() {
        return null;
      });
    }

    accessibleState.lastAutoModeState = { enabled: false, phase: "idle", totalProcessed: 0, totalChatted: 0 };
    setAccessibleStatus("持续自动投递已停止。", "warning");
    updateAccessibleDashboard();
    safeToast("持续自动投递已停止");
  }

  async function ensureResumeReady(form) {
	if (accessibleState.resumeSavePromise) {
	  return await accessibleState.resumeSavePromise;
	}
    if (form.resumeFile) {
	  return await saveAccessibleResumeFile(form);
    }

    if (form.resumeText) {
      setAccessibleStatus("正在保存这次补充的简历...", "running");
      const resumePayload = await requestJSON("/api/resumes/import", {
        method: "POST",
        body: JSON.stringify({
          resumeText: form.resumeText,
          profile: {
            targetRole: form.targetRole,
            location: form.targetCity
          }
        })
      });
      applyImportedResume(resumePayload.resume);
      return resumePayload.resume || null;
    }

    const latestResume = getLatestResume();
    if (latestResume) {
      return latestResume;
    }

    throw createAccessibleError("accessibleResumeText", "首次使用请展开“一次性补充简历”并粘贴完整简历");
  }

  function buildAccessibleResumeFileKey(resumeFile) {
	if (!resumeFile) {
	  return "";
	}
	return [resumeFile.name || "", resumeFile.size || 0, resumeFile.lastModified || 0].join("|");
  }

  async function saveAccessibleResumeFile(form) {
	const resumeFile = form && form.resumeFile;
	if (!resumeFile) {
	  return getLatestResume();
	}

	const fileKey = buildAccessibleResumeFileKey(resumeFile);
	if (fileKey && accessibleState.savedResumeFileKey === fileKey) {
	  return getLatestResume();
	}
	if (accessibleState.resumeSavePromise) {
	  return await accessibleState.resumeSavePromise;
	}

	const savePromise = (async function() {
	  setAccessibleStatus("正在读取并保存简历：" + String(resumeFile.name || "未命名文件"), "running");
	  const uploadPayload = new FormData();
	  uploadPayload.append("resumeFile", resumeFile, resumeFile.name);
	  uploadPayload.append("targetRole", form.targetRole);
	  uploadPayload.append("location", form.targetCity);
	  const resumePayload = await requestJSON("/api/resumes/import-file", {
		method: "POST",
		headers: {},
		body: uploadPayload
	  });
	  const resumeVersion = resumePayload.resume || null;
	  if (!resumeVersion || !resumeVersion.id) {
		throw new Error("简历保存失败：服务未返回有效简历");
	  }

	  accessibleState.savedResumeFileKey = fileKey;
	  applyImportedResume(resumeVersion);
	  await bindSavedResumeToCurrentAutomation(resumeVersion);
	  const fileInput = document.getElementById("accessibleResumeFile");
	  if (fileInput) {
		fileInput.value = "";
	  }
	  setAccessibleStatus("简历已保存，后续投递和 HR 回复都会使用这份简历。", "success");
	  safeToast("简历已保存：" + String(resumeVersion.sourceFileName || resumeFile.name || "当前简历"));
	  updateAccessibleDashboard();
	  return resumeVersion;
	})();

	accessibleState.resumeSavePromise = savePromise;
	try {
	  return await savePromise;
	} finally {
	  accessibleState.resumeSavePromise = null;
	}
  }

  async function bindSavedResumeToCurrentAutomation(resumeVersion) {
	const currentControl = accessibleState.automationControl || {};
	if (!resumeVersion || !resumeVersion.id || currentControl.enabled !== true) {
	  return;
	}
	const automationConfig = {
	  enabled: true,
	  resumeId: resumeVersion.id,
	  keyword: currentControl.keyword || DEFAULT_TARGET_ROLE,
	  city: currentControl.city || DEFAULT_TARGET_CITY,
	  chatMode: currentControl.chatMode || DEFAULT_CHAT_MODE,
	  scanIntervalMinutes: currentControl.scanIntervalMinutes || DEFAULT_SCAN_INTERVAL_MINUTES,
	  maxChatRounds: currentControl.maxChatRounds || DEFAULT_MAX_CHAT_ROUNDS,
	  maxJobsPerScan: currentControl.maxJobsPerScan || 500,
	  minMatchScore: currentControl.minMatchScore || readNumberValue("strategyMinScoreInput", 75, 1, 100)
	};
	await saveAccessibleAutomationControl(automationConfig, false);
	if (accessibleState.bridgeReady) {
	  await enableAccessibleAutoMode(automationConfig).catch(function() {
		return null;
	  });
	}
  }

  async function saveAccessibleStrategy(form) {
    const strategyPayload = {
      minMatchScore: readNumberValue("strategyMinScoreInput", 75, 1, 100),
      batchPrepareLimit: readNumberValue("strategyBatchLimitInput", 20, 1, 20),
      minSalaryK: form.minSalaryK,
      maxSalaryK: form.maxSalaryK,
      allowUnknownSalary: false,
      defaultChatMode: DEFAULT_CHAT_MODE,
      includeTitleKeywords: splitKeywordsSafe(form.targetRole),
      excludeTitleKeywords: splitKeywordsSafe(readInputValue("strategyExcludeTitleInput")),
      includeCompanyKeywords: [],
      excludeCompanyKeywords: splitKeywordsSafe(readInputValue("strategyExcludeCompanyInput")),
      includeDescriptionKeywords: [],
      excludeDescriptionKeywords: [],
      greetingPrompt: "优先突出与目标岗位直接相关的真实经验，避免冗长寒暄。"
    };

    const payload = await requestJSON("/api/delivery/strategy", {
      method: "POST",
      body: JSON.stringify(strategyPayload)
    });

    if (typeof renderStrategy === "function") {
      renderStrategy(payload.strategy);
    }
    if (typeof state !== "undefined") {
      state.deliveryStrategy = payload.strategy;
    }
    return payload.strategy;
  }

  function applyImportedResume(resumeVersion) {
    if (!resumeVersion) {
      return;
    }

    if (typeof state !== "undefined") {
      state.currentResume = resumeVersion;
      state.resumes = Array.isArray(state.resumes) ? state.resumes : [];
      state.resumes.push(resumeVersion);
    }

    if (resumeVersion.profile) {
      syncProfileInputs(resumeVersion.profile);
    }

    const preview = document.getElementById("resumePreview");
    if (preview) {
      preview.textContent = resumeVersion.markdown || "";
    }
    updateAccessibleDashboard();
  }

  function syncProfileInputs(profile) {
    forceInputValue("nameInput", profile.name || "");
    forceInputValue("roleInput", profile.targetRole || "");
    forceInputValue("yearsInput", profile.yearsExperience || "");
    forceInputValue("locationInput", profile.location || "");
    forceInputValue("emailInput", profile.email || "");
    forceInputValue("phoneInput", profile.phone || "");
    forceInputValue("educationInput", profile.education || "");
    forceInputValue("skillsInput", Array.isArray(profile.skills) ? profile.skills.join(", ") : "");
  }

  async function refreshAccessibleData() {
    const tasks = [];
    if (typeof loadDashboard === "function") {
      tasks.push(loadDashboard());
    }
    if (typeof loadJobs === "function") {
      tasks.push(loadJobs());
    }
    if (typeof loadQueue === "function") {
      tasks.push(loadQueue());
    }
    tasks.push(fetchAccessibleQueueState());
    if (typeof loadResumes === "function") {
      tasks.push(loadResumes());
    }
    await Promise.allSettled(tasks);
    updateAccessibleDashboard();
  }

  async function saveAccessibleAutomationControl(config, launchBrowser) {
    const payload = await requestJSON("/api/automation/control", {
      method: "POST",
      body: JSON.stringify({
        enabled: config && config.enabled === true,
        resumeId: config && config.resumeId ? config.resumeId : "",
        keyword: config && config.keyword ? config.keyword : "",
        city: config && config.city ? config.city : "",
        chatMode: config && config.chatMode ? config.chatMode : DEFAULT_CHAT_MODE,
        scanIntervalMinutes: config && config.scanIntervalMinutes ? config.scanIntervalMinutes : DEFAULT_SCAN_INTERVAL_MINUTES,
        maxChatRounds: config && config.maxChatRounds ? config.maxChatRounds : DEFAULT_MAX_CHAT_ROUNDS,
        maxJobsPerScan: config && config.maxJobsPerScan ? config.maxJobsPerScan : 50,
        minMatchScore: config && config.minMatchScore ? config.minMatchScore : readNumberValue("strategyMinScoreInput", 75, 1, 100),
        launchBrowser: launchBrowser === true
      })
    });
    applyAccessibleAutomationSnapshot(payload);
    return payload;
  }

  async function fetchAccessibleAutomationState() {
    const payload = await requestJSON("/api/automation/status");
    applyAccessibleAutomationSnapshot(payload);
    return payload;
  }

  async function fetchAccessibleQueueState() {
    const payload = await requestJSON("/api/delivery/queue");
    const queueItems = Array.isArray(payload && payload.items) ? payload.items : [];
    accessibleState.queueItems = queueItems;
    accessibleState.queueStats = payload && payload.stats
      ? payload.stats
      : buildQueueStatsFromItems(queueItems);
    return payload;
  }

  function buildQueueStatsFromItems(queueItems) {
    const statusCounts = {};
    (Array.isArray(queueItems) ? queueItems : []).forEach(function(queueItem) {
      const status = String((queueItem && queueItem.status) || "queued");
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    return {
      total: Array.isArray(queueItems) ? queueItems.length : 0,
      statusCounts: statusCounts
    };
  }

  function applyAccessibleAutomationSnapshot(payload) {
    accessibleState.automationControl = payload && payload.control ? payload.control : null;
    accessibleState.automationStatus = payload && payload.status ? payload.status : null;
    accessibleState.currentQueueItem = payload && payload.currentQueueItem ? payload.currentQueueItem : null;
    accessibleState.nextQueueItem = payload && payload.nextQueueItem ? payload.nextQueueItem : null;
    accessibleState.lastAutoModeState = buildAccessibleAutoModeState(accessibleState.automationStatus);
  }

  function buildAccessibleAutoModeState(automationStatus) {
    if (!automationStatus || typeof automationStatus !== "object") {
      return null;
    }
    const bridgeConnected = automationStatus.bridgeConnected === true;
    return {
      enabled: bridgeConnected && automationStatus.enabled === true,
      phase: String(automationStatus.phase || "idle"),
      currentQueueItemId: String(automationStatus.currentQueueItemId || ""),
      currentJobId: String(automationStatus.currentJobId || ""),
      currentRound: Number(automationStatus.currentRound || 0),
      totalProcessed: Number(automationStatus.totalProcessed || 0),
      totalChatted: Number(automationStatus.totalChatted || 0),
      keyword: accessibleState.automationControl && accessibleState.automationControl.keyword
        ? String(accessibleState.automationControl.keyword)
        : "",
      city: accessibleState.automationControl && accessibleState.automationControl.city
        ? String(accessibleState.automationControl.city)
        : "",
      bridgeConnected: bridgeConnected,
      errors: Array.isArray(automationStatus.errors) ? automationStatus.errors.slice() : []
    };
  }

  async function waitForAccessibleAutomationTakeover(timeoutMs) {
    const deadlineTime = Date.now() + Math.max(3000, timeoutMs || 15000);
    while (Date.now() <= deadlineTime) {
      await fetchAccessibleAutomationState().catch(function() {
        return null;
      });
      if (isAccessibleAutomationConnected() && accessibleState.lastAutoModeState && accessibleState.lastAutoModeState.enabled) {
        return accessibleState.lastAutoModeState;
      }
      await sleepAccessible(1500);
    }
    return accessibleState.lastAutoModeState;
  }

  function shouldLaunchAccessibleBrowser() {
    if (accessibleState.bridgeReady) {
      return false;
    }
    return !isAccessibleAutomationConnected();
  }

  function isAccessibleAutomationConnected() {
    return !!(accessibleState.automationStatus && accessibleState.automationStatus.bridgeConnected);
  }

  function isAccessibleAutomationRequested() {
    return !!(accessibleState.automationControl && accessibleState.automationControl.enabled);
  }

  function buildPendingAutomationMessage(launchErrorText) {
    if (launchErrorText) {
      return "自动求职任务已保存，但专用 Edge 启动失败：" + launchErrorText + "。修复后保持专用 Edge 打开，系统会自动继续。";
    }
    return "自动求职任务已保存，正在等待专用 Edge 自动化连接。连接后会自动开始找岗、投递和聊天。";
  }

  function sleepAccessible(delayMs) {
    return new Promise(function(resolve) {
      window.setTimeout(resolve, Math.max(0, Number(delayMs) || 0));
    });
  }

  function readAccessibleDraft() {
    const resumeFileInput = document.getElementById("accessibleResumeFile");
    return {
      resumeFile: resumeFileInput && resumeFileInput.files && resumeFileInput.files.length > 0
        ? resumeFileInput.files[0]
        : null,
      resumeText: readInputValue("accessibleResumeText").trim(),
      targetRole: readInputValue("accessibleTargetRole").trim(),
      targetCity: DEFAULT_TARGET_CITY,
      minSalaryK: readNumberValue("accessibleMinSalary", DEFAULT_MIN_SALARY_K, 0, 300),
      maxSalaryK: readNumberValue("accessibleMaxSalary", DEFAULT_MAX_SALARY_K, 0, 300),
      chatMode: DEFAULT_CHAT_MODE,
      scanIntervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES,
      maxChatRounds: DEFAULT_MAX_CHAT_ROUNDS,
      continuousMode: true
    };
  }

  function validateAccessibleForm(form) {
    clearFieldErrors();
    if (!form.targetRole) {
      throw createAccessibleError("accessibleTargetRole", "请填写目标岗位");
    }
    if (!form.targetCity) {
      throw createAccessibleError("accessibleTargetCity", "请填写目标城市");
    }
    if (form.maxSalaryK > 0 && form.minSalaryK > 0 && form.minSalaryK > form.maxSalaryK) {
      throw createAccessibleError("accessibleMinSalary", "最低月薪不能高于最高月薪");
    }
    if (form.resumeFile) {
      const fileName = String(form.resumeFile.name || "").toLowerCase();
      const extensionAllowed = ALLOWED_RESUME_FILE_EXTENSIONS.some(function(extension) {
        return fileName.endsWith(extension);
      });
      if (!extensionAllowed) {
        throw createAccessibleError("accessibleResumeFile", "简历文件仅支持 TXT、Markdown、DOCX");
      }
      if (form.resumeFile.size <= 0) {
        throw createAccessibleError("accessibleResumeFile", "简历文件不能为空");
      }
    }
    return form;
  }

  function readCurrentStrategy() {
    if (typeof state !== "undefined" && state.deliveryStrategy) {
      return state.deliveryStrategy;
    }
    return {
      includeTitleKeywords: [],
      defaultChatMode: DEFAULT_CHAT_MODE
    };
  }

  function setAccessibleRunning(running) {
    accessibleState.running = running;
    accessibleState.startupStartedAt = running ? Date.now() : 0;
    const startButton = document.getElementById("accessibleAutoApplyButton");
    if (startButton) {
      startButton.disabled = running;
      startButton.textContent = running ? "自动投递启动中..." : "开始自动求职";
    }
    updateAccessibleDashboard();
  }

  function setAccessibleStatus(message, tone) {
    const status = document.getElementById("accessibleAutoStatus");
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.tone = tone || "info";
    if (typeof setDebugStatus === "function") {
      setDebugStatus(message);
    }
  }

  function startAccessibleStatusPolling() {
    if (accessibleState.pollingTimer) {
      window.clearInterval(accessibleState.pollingTimer);
    }

    accessibleState.pollingTimer = window.setInterval(function() {
      pollAccessibleAutoModeStatus().catch(function() {});
    }, 5000);

    window.setTimeout(function() {
      pollAccessibleAutoModeStatus().catch(function() {});
    }, 1200);
  }

  async function pollAccessibleAutoModeStatus() {
    const automationPayload = await fetchAccessibleAutomationState().catch(function() {
      return null;
    });
    await fetchAccessibleQueueState().catch(function() {});

    if (automationPayload && accessibleState.lastAutoModeState) {
      if (accessibleState.running && accessibleState.lastAutoModeState.enabled && isAccessibleAutomationConnected()) {
        setAccessibleRunning(false);
        setAccessibleStatus("持续自动投递已开启，系统正在自动推进岗位队列。", "success");
        return;
      }
      if (accessibleState.running && isAccessibleAutomationRequested()) {
        if (hasAccessibleStartupTimedOut()) {
          settleAccessibleStartupTimeout();
          return;
        }
        setAccessibleStatus("自动求职任务已保存，正在等待专用 Edge 自动化接管，不需要重复点击。", "running");
      }
      updateAccessibleDashboard();
      return;
    }

    const currentAutoModeState = await requestAccessibleAutoModeState(AUTO_MODE_STATUS_TIMEOUT_MS).catch(function() {
      return null;
    });
    if (!currentAutoModeState) {
      settleAccessibleStartupTimeout();
      updateAccessibleDashboard();
      return;
    }

    accessibleState.lastAutoModeState = currentAutoModeState;
    if (accessibleState.running && currentAutoModeState.enabled) {
      setAccessibleRunning(false);
      setAccessibleStatus("持续自动投递已开启，系统正在自动推进岗位队列。", "success");
      return;
    }
    if (accessibleState.running && !currentAutoModeState.enabled) {
      settleAccessibleStartupTimeout();
      return;
    }
    updateAccessibleDashboard();
  }

  function updateAccessibleDashboard() {
    const form = readAccessibleDraft();
    const stateSnapshot = buildAccessibleStateSnapshot(typeof state !== "undefined" ? state : {});
    const queueStats = stateSnapshot.queueStats || { total: 0, statusCounts: {} };
    const statusCounts = queueStats.statusCounts || {};
    const autoModeState = accessibleState.lastAutoModeState || {};
    const latestResume = getLatestResume();
    const automationControl = accessibleState.automationControl || null;
    const automationStatus = accessibleState.automationStatus || null;
    const currentQueueItem = (autoModeState.enabled || (automationControl && automationControl.enabled))
      ? (accessibleState.currentQueueItem || findCurrentQueueItem(stateSnapshot, autoModeState))
      : null;

    setResumeState(latestResume, form.resumeText, form.resumeFile);
    setPrimaryHintText(buildPrimaryHintText(form, latestResume, autoModeState, currentQueueItem, queueStats, automationControl, automationStatus));
    setReadinessBadgeText(buildReadinessText(form, latestResume, autoModeState, automationControl, automationStatus));
    renderProgressFacts(stateSnapshot, statusCounts, autoModeState, automationControl, automationStatus);
    renderCurrentConversation(currentQueueItem, autoModeState, stateSnapshot, automationControl, automationStatus);
    renderQueueSummary(queueStats, statusCounts);
    renderQueuePreview(stateSnapshot, currentQueueItem);
  }

  function buildAccessibleStateSnapshot(baseState) {
    const stateSnapshot = Object.assign({}, baseState || {});
    if (Array.isArray(accessibleState.queueItems)) {
      stateSnapshot.queueItems = accessibleState.queueItems;
      stateSnapshot.queueStats = accessibleState.queueStats || buildQueueStatsFromItems(accessibleState.queueItems);
    }
    return stateSnapshot;
  }

  function buildPrimaryHintText(form, latestResume, autoModeState, currentQueueItem, queueStats, automationControl, automationStatus) {
    if (accessibleState.running) {
      return "系统正在启动持续自动投递，不需要重复点击。";
    }
    if (automationControl && automationControl.enabled && (!automationStatus || automationStatus.bridgeConnected !== true)) {
      return "自动求职任务已保存，正在等待专用 Edge 自动化连接。连接后系统会自动开始，不需要重复点击。";
    }
    if (!latestResume && !form.resumeText && !form.resumeFile) {
      return "第一次使用请展开“一次性补充简历”，粘贴一次完整简历。后续会自动复用。";
    }
    if (!form.targetRole || !form.targetCity) {
      return "先填写目标岗位和目标城市，再点击开始自动求职。";
    }
    if (autoModeState && autoModeState.enabled && currentQueueItem) {
      return "系统正在处理“" + buildQueueItemTitle(currentQueueItem) + "”，你不需要手动操作。";
    }
    if (autoModeState && autoModeState.enabled) {
      return "持续自动投递已开启，系统会继续自动找岗、发送开场白并推进下一个岗位。";
    }
    if ((queueStats.total || 0) > 0) {
      return "条件已经齐全，系统里已有待处理岗位。点击开始后会继续自动推进整个队列。";
    }
    return "条件已经齐全。点击开始后，系统会自动扫描岗位、发送开场白并继续投递。";
  }

  function buildReadinessText(form, latestResume, autoModeState, automationControl, automationStatus) {
    if (accessibleState.running) {
      return { text: "正在启动自动投递", tone: "running" };
    }
    if (autoModeState && autoModeState.enabled) {
      return { text: "持续自动运行中", tone: "running" };
    }
    if (automationControl && automationControl.enabled && (!automationStatus || automationStatus.bridgeConnected !== true)) {
      return { text: "等待专用 Edge 连接", tone: "pending" };
    }
    if (!latestResume && !form.resumeText && !form.resumeFile) {
      return { text: "缺少简历", tone: "pending" };
    }
    if (!form.targetRole || !form.targetCity) {
      return { text: "还差岗位或城市", tone: "pending" };
    }
    return { text: "已就绪，可直接开始", tone: "ready" };
  }

  function renderProgressFacts(stateSnapshot, statusCounts, autoModeState, automationControl, automationStatus) {
    const container = document.getElementById("accessibleProgressFacts");
    if (!container) {
      return;
    }
    container.innerHTML = "";

    [
      {
        label: "岗位库",
        value: String((stateSnapshot.jobs || []).length || 0),
        hint: "本地已同步岗位"
      },
      {
        label: "待处理队列",
        value: String((stateSnapshot.queueStats && stateSnapshot.queueStats.total) || 0),
        hint: "系统自动推进的岗位"
      },
      {
        label: "已自动投递",
        value: String(statusCounts.delivered || 0),
        hint: "已经成功发送"
      },
      {
        label: "自动状态",
        value: autoModeState && autoModeState.enabled
          ? phaseLabel(autoModeState.phase)
          : (automationControl && automationControl.enabled && (!automationStatus || automationStatus.bridgeConnected !== true) ? "等待 Edge 接管" : "未开启"),
        hint: autoModeState && autoModeState.enabled
          ? "已扫描 " + (autoModeState.totalProcessed || 0) + " 个，已投递 " + (autoModeState.totalChatted || 0) + " 次"
          : (automationControl && automationControl.enabled && (!automationStatus || automationStatus.bridgeConnected !== true)
            ? "任务已写入本地系统，浏览器连接后会自动开始"
            : "点击开始后进入持续模式")
      }
    ].forEach(function(item) {
      const fact = document.createElement("div");
      fact.className = "fact-item";

      const title = document.createElement("strong");
      title.textContent = item.label + "： " + item.value;
      fact.appendChild(title);

      const hint = document.createElement("span");
      hint.textContent = item.hint;
      fact.appendChild(hint);

      container.appendChild(fact);
    });
  }

  function renderCurrentConversation(currentQueueItem, autoModeState, stateSnapshot, automationControl, automationStatus) {
    const container = document.getElementById("accessibleCurrentConversation");
    if (!container) {
      return;
    }
    container.innerHTML = "";

    const title = document.createElement("strong");
    const detail = document.createElement("div");
    const hint = document.createElement("div");
    title.className = "current-chat-company";
    detail.className = "current-chat-position";
    hint.className = "current-chat-hint";
    const nextQueueItem = findNextQueueCandidate(stateSnapshot.queueItems || []);

    if (currentQueueItem) {
      title.textContent = buildQueueItemCompany(currentQueueItem);
      detail.textContent = buildQueueItemPosition(currentQueueItem);
      hint.textContent = buildQueueItemMeta(currentQueueItem) + "。当前阶段：" + phaseLabel(autoModeState.phase) + "，开场白发出后会继续处理下一个岗位。";
    } else if (automationControl && automationControl.enabled && (!automationStatus || automationStatus.bridgeConnected !== true)) {
      title.textContent = "正在等待专用 Edge 接管";
      detail.textContent = (automationControl.keyword || "目标岗位未设置") + "｜" + (automationControl.city || "目标城市未设置");
      hint.textContent = "系统已经记住你的求职条件。专用 Edge 连接后，会自动扫描、投递并与 HR 沟通。";
    } else if (autoModeState && autoModeState.enabled && nextQueueItem) {
      title.textContent = "正在准备下一岗位：" + buildQueueItemCompany(nextQueueItem);
      detail.textContent = buildQueueItemPosition(nextQueueItem);
      hint.textContent = buildQueueItemMeta(nextQueueItem) + "。队列已有可处理岗位，系统会自动打开岗位并发起沟通。";
    } else if (autoModeState && autoModeState.enabled) {
      title.textContent = autoModeState.phase === "scanning" ? "正在自动翻页补充新岗位" : "等待下一轮自动补充岗位";
      detail.textContent = (autoModeState.keyword || "目标岗位未设置") + "｜" + (autoModeState.city || "目标城市未设置");
      hint.textContent = autoModeState.phase === "scanning"
        ? "待处理队列暂时为空，系统正在扫描 BOSS 的后续页面并把符合条件的岗位加入队列。"
        : "本轮暂时没有可处理岗位，系统会在约 10 秒后自动重新扫描，不需要手动补岗位。";
    } else if ((stateSnapshot.queueItems || []).length > 0) {
      if (nextQueueItem) {
        title.textContent = "下一条将处理：" + buildQueueItemCompany(nextQueueItem);
        detail.textContent = buildQueueItemPosition(nextQueueItem);
        hint.textContent = buildQueueItemMeta(nextQueueItem) + "。点击开始后，系统会自动继续推进这条岗位。";
      } else {
        title.textContent = "当前没有正在沟通的岗位";
        detail.textContent = "队列中暂时没有可继续推进的岗位。";
        hint.textContent = "系统会在后续扫描到合格岗位后自动加入队列。";
      }
    } else {
      title.textContent = "当前没有正在沟通的岗位";
      detail.textContent = "还没有进入自动沟通阶段。";
      hint.textContent = "填写好岗位、城市、薪资范围后点击开始即可。";
    }

    container.appendChild(title);
    container.appendChild(detail);
    container.appendChild(hint);
  }

  function renderQueueSummary(queueStats, statusCounts) {
    const container = document.getElementById("accessibleQueueSummary");
    if (!container) {
      return;
    }
    container.innerHTML = "";

    [
      "总数 " + (queueStats.total || 0),
      "已准备 " + (statusCounts.prepared || 0),
      "沟通中 " + ((statusCounts.opened || 0) + (statusCounts.filled || 0)),
      "已投递 " + (statusCounts.delivered || 0)
    ].forEach(function(text) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = text;
      container.appendChild(tag);
    });
  }

  function renderQueuePreview(stateSnapshot, currentQueueItem) {
    const container = document.getElementById("accessibleQueueList");
    if (!container) {
      return;
    }
    container.innerHTML = "";

    const queueItems = buildQueuePreviewItems(stateSnapshot.queueItems || [], currentQueueItem);
    if (queueItems.length === 0) {
      const emptyItem = document.createElement("div");
      emptyItem.className = "result-item muted";
      emptyItem.textContent = "当前队列为空。系统扫描到合格岗位后会自动加入这里。";
      container.appendChild(emptyItem);
      return;
    }

    queueItems.forEach(function(queueItem) {
      const item = document.createElement("div");
      item.className = "result-item";

      const title = document.createElement("strong");
      title.textContent = buildQueueItemTitle(queueItem);
      item.appendChild(title);

      const meta = document.createElement("p");
      meta.textContent = buildQueueItemMeta(queueItem);
      item.appendChild(meta);

      const status = document.createElement("p");
      status.textContent = "状态：" + queueStatusText(queueItem.status);
      item.appendChild(status);

      container.appendChild(item);
    });
  }

  function buildQueuePreviewItems(queueItems, currentQueueItem) {
    const orderedItems = [];
    const usedIds = new Set();

    if (currentQueueItem && currentQueueItem.id) {
      orderedItems.push(currentQueueItem);
      usedIds.add(currentQueueItem.id);
    }

    queueItems
      .slice()
      .sort(function(leftItem, rightItem) {
        return queuePriority(leftItem) - queuePriority(rightItem);
      })
      .forEach(function(queueItem) {
        if (!queueItem || !queueItem.id || usedIds.has(queueItem.id)) {
          return;
        }
        orderedItems.push(queueItem);
        usedIds.add(queueItem.id);
      });

    return orderedItems.slice(0, QUEUE_PREVIEW_LIMIT);
  }

  function queuePriority(queueItem) {
    const status = String((queueItem && queueItem.status) || "");
    const missingURLPenalty = hasQueueItemURL(queueItem) ? 0 : 10;
    if (status === "opened" || status === "filled") {
      return 1 + missingURLPenalty;
    }
    if (status === "prepared") {
      return 2 + missingURLPenalty;
    }
    if (status === "queued") {
      return 3 + missingURLPenalty;
    }
    if (status === "delivered") {
      return 5 + missingURLPenalty;
    }
    if (status === "skipped" || status === "rejected") {
      return 6 + missingURLPenalty;
    }
    return 4 + missingURLPenalty;
  }

  function findCurrentQueueItem(stateSnapshot, autoModeState) {
    const queueItems = Array.isArray(stateSnapshot.queueItems) ? stateSnapshot.queueItems : [];
    const currentQueueItemId = String((autoModeState && autoModeState.currentQueueItemId) || "");
    if (currentQueueItemId) {
      const matchedQueueItem = queueItems.find(function(queueItem) {
        return queueItem && queueItem.id === currentQueueItemId;
      });
      if (matchedQueueItem) {
        return matchedQueueItem;
      }
    }

    const currentJobId = String((autoModeState && autoModeState.currentJobId) || "");
    if (currentJobId) {
      const matchedByJobId = queueItems.find(function(queueItem) {
        return queueItem && queueItem.jobId === currentJobId;
      });
      if (matchedByJobId) {
        return matchedByJobId;
      }
    }

    return null;
  }

  function findNextQueueCandidate(queueItems) {
    return queueItems
      .filter(function(queueItem) {
        const status = String((queueItem && queueItem.status) || "");
        return status === "prepared" || status === "queued" || status === "opened" || status === "filled" || status === "";
      })
      .sort(function(leftItem, rightItem) {
        return queuePriority(leftItem) - queuePriority(rightItem);
      })[0] || null;
  }

  function listPendingQueueItems(targetRole) {
    if (typeof state === "undefined" || !Array.isArray(state.queueItems)) {
      return [];
    }
    const normalizedTargetRole = String(targetRole || "").trim().toLowerCase().replace(/\s+/g, "");
    return state.queueItems.filter(function(queueItem) {
      const status = String((queueItem && queueItem.status) || "");
      if (status === "delivered" || status === "skipped" || status === "rejected") {
        return false;
      }
      if (!normalizedTargetRole) {
        return true;
      }
      const normalizedTitle = String((queueItem && queueItem.title) || "").trim().toLowerCase().replace(/\s+/g, "");
      return normalizedTitle.indexOf(normalizedTargetRole) >= 0;
    });
  }

  function hasQueueItemURL(queueItem) {
    return String((queueItem && queueItem.url) || "").trim() !== "";
  }

  function getLatestResume() {
    if (typeof state === "undefined") {
      return null;
    }
    if (state.currentResume && state.currentResume.id) {
      return state.currentResume;
    }
    const resumes = Array.isArray(state.resumes) ? state.resumes : [];
    return resumes.length > 0 ? resumes[resumes.length - 1] : null;
  }

  function setResumeState(latestResume, draftResumeText, draftResumeFile) {
    const title = document.getElementById("accessibleResumeState");
    const hint = document.getElementById("accessibleResumeHint");
    if (!title || !hint) {
      return;
    }

    if (draftResumeFile) {
      title.textContent = "本次将上传简历文件：" + String(draftResumeFile.name || "未命名文件");
      hint.textContent = "点击开始后会先读取并保存这份简历，再自动开始投递。";
      return;
    }

    if (draftResumeText) {
      title.textContent = "本次将使用你刚补充的简历。";
      hint.textContent = "点击开始后会先保存这份简历，再自动开始投递。";
      return;
    }

    if (latestResume) {
      const targetRole = latestResume.profile && latestResume.profile.targetRole ? latestResume.profile.targetRole : "最近保存的求职方向";
	  const sourceFileName = String(latestResume.sourceFileName || "").trim();
	  title.textContent = sourceFileName ? "当前已保存简历：" + sourceFileName : "当前将使用最近保存的简历。";
	  hint.textContent = "最近简历目标：" + targetRole + "。后续投递和 HR 回复会自动复用；如果需要更换，重新选择文件即可。";
      return;
    }

    title.textContent = "系统里还没有简历。";
    hint.textContent = "请展开下方“一次性补充简历”，粘贴一次完整简历即可。";
  }

  function phaseLabel(phase) {
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
      error: "异常处理中",
      cancelled: "已停止"
    };
    return labels[phase] || phase || "未知阶段";
  }

  function queueStatusText(status) {
    if (typeof queueStatusLabel === "function") {
      return queueStatusLabel(status);
    }
    const labels = {
      queued: "待准备",
      prepared: "已准备",
      opened: "已打开",
      filled: "已填入",
      delivered: "已投递",
      skipped: "已跳过",
      rejected: "不合适"
    };
    return labels[status] || status || "未知状态";
  }

  function buildQueueItemTitle(queueItem) {
    return buildQueueItemCompany(queueItem) + "｜" + buildQueueItemPosition(queueItem);
  }

  function buildQueueItemCompany(queueItem) {
    return normalizeDisplayText(queueItem && queueItem.company, "未知公司");
  }

  function buildQueueItemPosition(queueItem) {
    return normalizeDisplayText(queueItem && queueItem.title, "未知岗位");
  }

  function buildQueueItemMeta(queueItem) {
    return [
      normalizeDisplayText(queueItem && queueItem.location, ""),
      normalizeSalaryText(queueItem && queueItem.salary),
      "匹配度 " + ((queueItem && queueItem.matchScore) || 0)
    ].filter(Boolean).join("｜");
  }

  function normalizeDisplayText(value, fallback) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text || fallback || "";
  }

  function normalizeSalaryText(value) {
    const salaryText = normalizeDisplayText(value, "");
    if (!salaryText) {
      return "";
    }
    if (/[\uE000-\uF8FF□�]/.test(salaryText)) {
      return "薪资待确认";
    }
    return salaryText;
  }

  async function ensureAccessibleBridgeReady() {
    const currentAutoModeState = await requestAccessibleAutoModeState(BRIDGE_PREFLIGHT_TIMEOUT_MS).catch(function() {
      return null;
    });
    if (currentAutoModeState) {
      accessibleState.lastAutoModeState = currentAutoModeState;
      accessibleState.bridgeReady = true;
      return;
    }

    await waitForAccessibleBridgeHandshake(1200).catch(function() {
      return null;
    });

    const retriedAutoModeState = await requestAccessibleAutoModeState(BRIDGE_PREFLIGHT_TIMEOUT_MS).catch(function() {
      return null;
    });
    if (retriedAutoModeState) {
      accessibleState.lastAutoModeState = retriedAutoModeState;
      accessibleState.bridgeReady = true;
      return;
    }

    if (accessibleState.bridgeReady) {
      throw new Error("自动求职任务已保存，正在等待专用 Edge 自动化连接。连接后会自动继续。");
    }
    throw new Error("自动求职任务已保存，请保持专用 Edge 打开。系统连接后会自动开始找岗、投递和聊天。");
  }

  async function enableAccessibleAutoMode(config) {
    try {
      const result = await bridgeRequest(
        "jobCopilotSetAutoMode",
        "jobCopilotSetAutoModeResult",
        { config: config || {} },
        12000
      );
      if (result && result.state && result.state.enabled) {
        return result.state;
      }
    } catch (error) {
      const fallbackState = await requestAccessibleAutoModeState(BRIDGE_PREFLIGHT_TIMEOUT_MS).catch(function() {
        return null;
      });
      if (fallbackState && fallbackState.enabled) {
        return fallbackState;
      }
      throw error;
    }

    const currentAutoModeState = await requestAccessibleAutoModeState(BRIDGE_PREFLIGHT_TIMEOUT_MS).catch(function() {
      return null;
    });
    if (currentAutoModeState && currentAutoModeState.enabled) {
      return currentAutoModeState;
    }
    throw new Error("自动投递没有成功开启，请刷新页面后重试");
  }

  async function requestAccessibleAutoModeState(timeoutMs) {
    const automationPayload = await fetchAccessibleAutomationState().catch(function() {
      return null;
    });
    if (automationPayload && accessibleState.lastAutoModeState) {
      return accessibleState.lastAutoModeState;
    }

    const result = await bridgeRequest(
      "jobCopilotGetAutoModeStatus",
      "jobCopilotGetAutoModeStatusResult",
      {},
      timeoutMs || AUTO_MODE_STATUS_TIMEOUT_MS
    );
    if (!result || !result.state || typeof result.state !== "object") {
      throw new Error("浏览器扩展状态不可用");
    }
    return result.state;
  }

  function waitForAccessibleBridgeHandshake(timeoutMs) {
    if (accessibleState.bridgeReady) {
      return Promise.resolve();
    }

    return new Promise(function(resolve, reject) {
      const timer = window.setTimeout(function() {
        window.removeEventListener("message", onBridgeReady);
        reject(new Error("bridge-handshake-timeout"));
      }, Math.max(300, timeoutMs || BRIDGE_PREFLIGHT_TIMEOUT_MS));

      function onBridgeReady(event) {
        if (event.source !== window || !event.data || event.data.type !== "jobCopilotBridgeReady") {
          return;
        }
        accessibleState.bridgeReady = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", onBridgeReady);
        resolve();
      }

      window.addEventListener("message", onBridgeReady);
    });
  }

  function settleAccessibleStartupTimeout() {
    if (!accessibleState.running || !hasAccessibleStartupTimedOut()) {
      return;
    }
    const timeoutMessage = "自动求职任务已保存，正在等待专用 Edge 自动化连接。无需重复点击，连接后会自动继续。";
    setAccessibleStatus(timeoutMessage, "warning");
    safeToast(timeoutMessage);
    setAccessibleRunning(false);
  }

  function hasAccessibleStartupTimedOut() {
    return accessibleState.startupStartedAt > 0
      && Date.now() - accessibleState.startupStartedAt >= AUTO_MODE_START_TIMEOUT_MS;
  }

  function bridgeRequest(requestType, resultType, payload, timeoutMs) {
    return new Promise(function(resolve, reject) {
      const requestId = requestType + "_" + Date.now() + "_" + Math.random().toString(16).slice(2);
      const timer = window.setTimeout(function() {
        window.removeEventListener("message", onResult);
        reject(new Error("自动求职任务已保存，正在等待专用 Edge 自动化连接。连接后会自动继续。"));
      }, timeoutMs || 20000);

      function onResult(event) {
        if (event.source !== window || !event.data || event.data.type !== resultType) {
          return;
        }
        if (event.data.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener("message", onResult);
        accessibleState.bridgeReady = true;
        if (event.data.ok === false) {
          reject(new Error(event.data.error || "插件操作失败"));
          return;
        }
        resolve(event.data);
      }

      window.addEventListener("message", onResult);
      window.postMessage(
        Object.assign(
          {
            type: requestType,
            requestId: requestId
          },
          payload || {}
        ),
        window.location.origin
      );
    });
  }

  function handleAccessibleBridgeEvent(event) {
    if (event.source !== window || !event.data) {
      return;
    }
    if (event.data.type === "jobCopilotBridgeReady") {
      accessibleState.bridgeReady = true;
    }
  }

  function readInputValue(id) {
    const element = document.getElementById(id);
    return element ? String(element.value || "") : "";
  }

  function setInputValue(id, value) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    if (element.value && String(element.value).trim() !== "") {
      return;
    }
    element.value = value;
  }

  function forceInputValue(id, value) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    element.value = value;
  }

  function setNumberValue(id, value) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    if (element.value && String(element.value).trim() !== "") {
      return;
    }
    element.value = String(value);
  }

  function readNumberValue(id, fallback, min, max) {
    const element = document.getElementById(id);
    const parsedValue = Number.parseInt(element ? element.value : "", 10);
    if (Number.isNaN(parsedValue)) {
      return fallback;
    }
    if (typeof min === "number" && parsedValue < min) {
      return min;
    }
    if (typeof max === "number" && parsedValue > max) {
      return max;
    }
    return parsedValue;
  }

  function splitKeywordsSafe(value) {
    return String(value || "")
      .split(/[,，、\s]+/)
      .map(function(item) {
        return item.trim();
      })
      .filter(Boolean);
  }

  function safeToast(message) {
    if (typeof showToast === "function") {
      showToast(message);
    }
  }

  function normalizeAccessibleErrorMessage(message) {
    const rawMessage = String(message || "").trim();
    if (!rawMessage) {
      return "自动求职执行失败";
    }

    const bridgeErrorKeywords = [
      "浏览器扩展未加载",
      "浏览器扩展未连接",
      "插件未响应",
      "Chrome 扩展",
      "扩展桥接客户端未加载"
    ];
    const matchedBridgeError = bridgeErrorKeywords.some(function(keyword) {
      return rawMessage.indexOf(keyword) >= 0;
    });
    if (matchedBridgeError) {
      return "自动求职任务已保存，正在等待专用 Edge 自动化连接。连接后会自动继续。";
    }
    return rawMessage;
  }

  function handleAccessibleError(error) {
    const message = normalizeAccessibleErrorMessage(error && error.message ? error.message : "自动求职执行失败");
    if (error && error.fieldId) {
      markFieldError(error.fieldId);
      focusAndRevealField(error.fieldId);
    }
    const waitingMessage = message.indexOf("等待专用 Edge 自动化连接") >= 0 || message.indexOf("请保持专用 Edge 打开") >= 0;
    setAccessibleStatus(message, waitingMessage ? "warning" : "error");
    safeToast(message);
    setAccessibleRunning(false);
    updateAccessibleDashboard();
  }

  function bindAccessibleFieldListeners() {
    accessibleFieldIds.forEach(function(fieldId) {
      const element = document.getElementById(fieldId);
      if (!element) {
        return;
      }
      element.addEventListener("input", function() {
        clearFieldError(fieldId);
        updateAccessibleDashboard();
      });
      element.addEventListener("change", function() {
        clearFieldError(fieldId);
        updateAccessibleDashboard();
		if (fieldId === "accessibleResumeFile") {
		  const draft = validateAccessibleForm(readAccessibleDraft());
		  if (draft.resumeFile) {
			saveAccessibleResumeFile(draft).catch(function(error) {
			  handleAccessibleError(error);
			});
		  }
		}
      });
    });
  }

  function setPrimaryHintText(message) {
    const element = document.getElementById("accessiblePrimaryHint");
    if (!element) {
      return;
    }
    element.textContent = message;
  }

  function setReadinessBadgeText(payload) {
    const element = document.getElementById("accessibleReadiness");
    if (!element) {
      return;
    }
    element.textContent = payload.text;
    element.dataset.tone = payload.tone || "pending";
  }

  function createAccessibleError(fieldId, message) {
    const error = new Error(message);
    error.fieldId = fieldId;
    return error;
  }

  function clearFieldErrors() {
    accessibleFieldIds.forEach(clearFieldError);
  }

  function clearFieldError(fieldId) {
    const element = document.getElementById(fieldId);
    if (!element) {
      return;
    }
    element.classList.remove("field-error");
  }

  function markFieldError(fieldId) {
    const element = document.getElementById(fieldId);
    if (!element) {
      return;
    }
    element.classList.add("field-error");
  }

  function focusAndRevealField(fieldId) {
    const element = document.getElementById(fieldId);
    if (!element) {
      return;
    }
    const parentDetails = element.closest("details");
    if (parentDetails) {
      parentDetails.open = true;
    }
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(function() {
      element.focus();
    }, 160);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }
  init();
})();

(function initializeBossSearchPolicy(root) {
  "use strict";

  const BOSS_SALARY_BANDS = Object.freeze([
    Object.freeze({ code: "402", label: "3K以下", minK: 0, maxK: 3 }),
    Object.freeze({ code: "403", label: "3-5K", minK: 3, maxK: 5 }),
    Object.freeze({ code: "404", label: "5-10K", minK: 5, maxK: 10 }),
    Object.freeze({ code: "405", label: "10-20K", minK: 10, maxK: 20 }),
    Object.freeze({ code: "406", label: "20-50K", minK: 20, maxK: 50 }),
    Object.freeze({ code: "407", label: "50K以上", minK: 50, maxK: Number.POSITIVE_INFINITY })
  ]);

  const BOSS_POSITION_RULES = Object.freeze([
    Object.freeze({ code: "100116", label: "Golang", category: "互联网/AI", keywords: Object.freeze(["golang", "go语言", "go后端"]) })
  ]);

  const BOSS_JOB_TYPES = Object.freeze({
    fullTime: Object.freeze({ code: "1901", label: "全职" }),
    partTime: Object.freeze({ code: "1903", label: "兼职" })
  });

  // BOSS 只提供固定薪资档位。未设置最高月薪时不套用 BOSS 薪资筛选，
  // 避免 20-50K 档位遗漏 50K 以上岗位；最低薪资由本地策略精确过滤。
  function resolveSalaryBand(minSalaryK, maxSalaryK) {
    const minK = normalizeSalaryK(minSalaryK);
    const maxK = normalizeSalaryK(maxSalaryK);
    if (minK <= 0 && maxK <= 0) {
      return null;
    }

    if (minK > 0 && maxK <= 0) {
      return null;
    }

    const effectiveMinK = minK > 0 ? minK : maxK;
    const effectiveMaxK = maxK > 0 ? maxK : minK;
    if (effectiveMinK <= 0 || effectiveMaxK <= 0 || effectiveMinK > effectiveMaxK) {
      return null;
    }

    return BOSS_SALARY_BANDS
      .filter(function(band) {
        return effectiveMinK >= band.minK && effectiveMaxK <= band.maxK;
      })
      .sort(function(left, right) {
        return salaryBandWidth(left) - salaryBandWidth(right);
      })[0] || null;
  }

  function salaryBandWidth(band) {
    if (!Number.isFinite(band.maxK)) {
      return Number.MAX_SAFE_INTEGER;
    }
    return band.maxK - band.minK;
  }

  function normalizeSalaryK(value) {
    const parsedValue = Math.round(Number(value));
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      return 0;
    }
    return parsedValue;
  }

  // 仅映射已在 BOSS 真实筛选项中确认过的岗位类型，未识别的岗位保持不限。
  function resolvePosition(keyword) {
    const normalizedKeyword = String(keyword || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (!normalizedKeyword) {
      return null;
    }

    return BOSS_POSITION_RULES.find(function(rule) {
      return rule.keywords.some(function(candidate) {
        return normalizedKeyword.includes(candidate);
      });
    }) || null;
  }

  // 当前产品用于正式岗位自动投递；明确写有“兼职”时才切换兼职，其余普通岗位使用全职。
  function resolveJobType(keyword) {
    const normalizedKeyword = String(keyword || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (!normalizedKeyword || normalizedKeyword.includes("实习")) {
      return null;
    }
    if (normalizedKeyword.includes("兼职")) {
      return BOSS_JOB_TYPES.partTime;
    }
    return BOSS_JOB_TYPES.fullTime;
  }

  function shouldStopAfterNewBatch(stopAfterFirstNewBatch, newJobCount) {
    return stopAfterFirstNewBatch === true && Number(newJobCount) > 0;
  }

  function selectNextJobBatch(jobs, oneJobAtATime) {
    const normalizedJobs = Array.isArray(jobs) ? jobs : [];
    if (oneJobAtATime === true && normalizedJobs.length > 0) {
      return [normalizedJobs[0]];
    }
    return normalizedJobs;
  }

  // 优先复用持续模式记录的工作页，其次复用职位搜索页，最后复用任意 BOSS 页面。
  function selectReusableBossTab(tabs, preferredTabId) {
    const bossTabs = (Array.isArray(tabs) ? tabs : []).filter(function(tab) {
      return tab && Number.isInteger(Number(tab.id)) && isBossURL(tab.url);
    });
    const normalizedPreferredTabId = Number(preferredTabId);
    if (normalizedPreferredTabId > 0) {
      const preferredTab = bossTabs.find(function(tab) {
        return Number(tab.id) === normalizedPreferredTabId;
      });
      if (preferredTab) {
        return preferredTab;
      }
    }

    return bossTabs.find(function(tab) {
      return String(tab.url || "").includes("/web/geek/jobs");
    }) || bossTabs[0] || null;
  }

  function isBossURL(rawURL) {
    try {
      const parsedURL = new URL(String(rawURL || ""));
      return parsedURL.protocol === "https:" && (parsedURL.hostname === "zhipin.com" || parsedURL.hostname.endsWith(".zhipin.com"));
    } catch (error) {
      return false;
    }
  }

  // 仅识别平台明确展示的终态文案，避免把职位描述里的“关闭”等普通文字误判为已停止招聘。
  function isClosedJobStatusText(text) {
    const normalizedText = String(text || "")
      .replace(/[\s：:，,。.!！]+/g, "")
      .trim();
    return /^(?:职位|岗位)(?:已关闭|已下线)$/.test(normalizedText)
      || /^(?:招聘已结束|停止招聘|已停止招聘|招聘者已停止招聘)$/.test(normalizedText);
  }

  const policy = Object.freeze({
    BOSS_SALARY_BANDS,
    BOSS_POSITION_RULES,
    BOSS_JOB_TYPES,
    resolveSalaryBand,
    resolvePosition,
    resolveJobType,
    shouldStopAfterNewBatch,
    selectNextJobBatch,
    selectReusableBossTab,
    isBossURL,
    isClosedJobStatusText
  });

  root.JobCopilotBossSearchPolicy = policy;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = policy;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

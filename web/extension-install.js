(function installExtensionAssistant() {
  "use strict";

  var banner = null;
  var messageElement = null;
  var statusElement = null;
  var openButton = null;
  var packageButton = null;
  var launchButton = null;
  var dismissButton = null;
  var timerId = null;
  var renderedState = "";
  var launching = false;

  var checkIntervalMs = 6000;
  var dismissTTLms = 60 * 60 * 1000;
  var dismissStorageKey = "job_copilot_extension_notice_dismiss_until";

  function getExtensionManagerURL() {
    var userAgent = String(navigator.userAgent || "").toLowerCase();
    if (userAgent.indexOf("edg/") >= 0) {
      return "edge://extensions/";
    }
    return "chrome://extensions/";
  }

  function init() {
    banner = document.getElementById("extensionInstallBanner");
    messageElement = document.getElementById("extensionInstallMessage");
    statusElement = document.getElementById("extensionInstallStatus");
    openButton = document.getElementById("extensionOpenPageButton");
    packageButton = document.getElementById("extensionPackageButton");
    launchButton = document.getElementById("extensionLaunchButton");
    dismissButton = document.getElementById("extensionDismissButton");

    if (!banner || !messageElement || !openButton || !packageButton || !launchButton || !dismissButton) {
      return;
    }

    openButton.href = getExtensionManagerURL();
    openButton.textContent = "打开扩展管理页";
    dismissButton.addEventListener("click", onDismiss);
    launchButton.addEventListener("click", onLaunchBrowser);
    packageButton.href = "/api/extension/package";
    setStatusMessage("如需手动安装，可先下载扩展安装包后在“扩展管理页”使用“加载已解压的扩展”；建议优先点击“点击即安装（含启动）”。", "ok");

    window.setTimeout(checkAndRender, 1000);
    if (timerId !== null) {
      return;
    }
    timerId = window.setInterval(checkAndRender, checkIntervalMs);
  }

  function onDismiss() {
    hideBanner();
    var until = Date.now() + dismissTTLms;
    try {
      window.localStorage.setItem(dismissStorageKey, String(until));
    } catch (error) {}
  }

  function canShowBanner() {
    try {
      var raw = window.localStorage.getItem(dismissStorageKey);
      var until = Number(raw || 0);
      return !(Number.isFinite(until) && until > Date.now());
    } catch (error) {
      return true;
    }
  }

  function setStatusMessage(message, tone) {
    if (!statusElement) {
      return;
    }
    statusElement.textContent = String(message || "");
    statusElement.className = "extension-install-status";
    if (tone === "ok") {
      statusElement.className = "extension-install-status ok";
    }
    if (tone === "error") {
      statusElement.className = "extension-install-status error";
    }
  }

  function launchDedicatedBrowser() {
    return requestJSONWithFallback("/api/extension/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  }

  function onLaunchBrowser() {
    if (launching) {
      return;
    }
    launching = true;
    if (launchButton) {
      launchButton.disabled = true;
      launchButton.textContent = "正在一键安装（含启动）...";
    }
    setStatusMessage("正在执行内置安装命令，请保持系统窗口可见。", "ok");

    launchDedicatedBrowser().then(function handleLaunchResult(response) {
      var message = String((response && response.message) || "已发送一键安装指令，请稍后在浏览器端确认扩展状态。");
      setStatusMessage(message, "ok");
      if (launchButton) {
        launchButton.textContent = "已发起一键安装（含启动）";
      }
      window.setTimeout(function() {
        if (timerId) {
          checkAndRender();
        }
      }, 1200);
    }).catch(function(error) {
      setStatusMessage(error && error.message ? error.message : "启动失败，请手动在扩展管理页安装扩展。", "error");
      if (launchButton) {
        launchButton.disabled = false;
        launchButton.textContent = "点击即安装（含启动）";
      }
    }).finally(function() {
      launching = false;
      if (launchButton && launchButton.disabled) {
        launchButton.disabled = false;
        launchButton.textContent = "点击即安装（含启动）";
      }
    });
  }

  function shouldShowControlNotice(payload) {
    var control = (payload && payload.control) || {};
    var status = (payload && payload.status) || {};
    var automationEnabled = control.enabled === true;
    var bridgeConnected = status.bridgeConnected === true;
    return automationEnabled && !bridgeConnected;
  }

  function buildHint(payload) {
    var control = (payload && payload.control) || {};
    var status = (payload && payload.status) || {};
    var keyword = String(control.keyword || "");
    var city = String(control.city || "");
    var phase = String(status.phase || "idle");
    var filters = [];

    if (keyword) {
      filters.push("岗位关键词：" + keyword);
    }
    if (city) {
      filters.push("城市：" + city);
    }
    if (filters.length > 0) {
      return "当前自动化已开启（" + phase + "）但未检测到扩展桥接，可直接点击“点击即安装（含启动）”尝试自动恢复；当前筛选：" + filters.join("，") + "。";
    }
    return "当前自动化已开启（" + phase + "）但未检测到扩展桥接，请先点击“点击即安装（含启动）”，或下载后手动加载扩展。";
  }

  function renderVisible(payload) {
    var nextState = shouldShowControlNotice(payload) ? "show" : "hide";
    if (nextState === renderedState) {
      return;
    }
    renderedState = nextState;

    if (!shouldShowControlNotice(payload) || !canShowBanner()) {
      hideBanner();
      setStatusMessage("");
      return;
    }

    messageElement.textContent = buildHint(payload);
    if (statusElement && !statusElement.textContent) {
      setStatusMessage("如仍无法接入，请检查专用 Edge 是否保持登录并允许扩展运行。", "ok");
    }
    banner.hidden = false;
  }

  function hideBanner() {
    if (!banner) {
      return;
    }
    banner.hidden = true;
  }

  function requestJSONWithFallback(path) {
    var options = null;
    if (arguments.length > 1 && arguments[1]) {
      options = arguments[1];
    } else {
      options = {};
    }
    if (typeof requestJSON === "function") {
      return requestJSON(path, options);
    }
    return window.fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" }
    }, options)).then(function parseResponse(response) {
      return response.text().then(function(responseText) {
        var trimmed = String(responseText || "").trim();
        var payload = null;
        if (trimmed !== "") {
          try {
            payload = JSON.parse(trimmed);
          } catch (error) {
            throw new Error("服务响应不是合法 JSON");
          }
        }
        if (!response.ok) {
          if (payload && typeof payload === "object" && payload.error) {
            throw new Error(payload.error);
          }
          throw new Error("服务异常，状态码 " + response.status);
        }
        return payload;
      });
    });
  }

  function checkAndRender() {
    if (document.hidden) {
      return;
    }
    requestJSONWithFallback("/api/automation/status")
      .then(function(payload) {
        renderVisible(payload);
      })
      .catch(function() {
        if (banner && !canShowBanner()) {
          hideBanner();
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }
  init();
})();

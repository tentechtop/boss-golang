// 功能目的：连接系统页和扩展后台；实现原因：普通网页不能直接调用 chrome.runtime，且当前 Edge 环境需绕开不稳定消息通道。
(function installJobCopilotSystemBridge() {
  const BRIDGE_SCRIPT_VERSION = "0.3.7";

  if (window.__jobCopilotSystemBridgeInstalled) {
    return;
  }
  window.__jobCopilotSystemBridgeInstalled = true;

  window.addEventListener("message", function(event) {
    if (event.source !== window || !event.data || typeof event.data.type !== "string") {
      return;
    }
    handlePageCommand(event.data);
  });

  async function handlePageCommand(message) {
    switch (message.type) {
      case "jobCopilotPullJobs":
        await forwardBridgeCommand("pullBossJobs", "jobCopilotPullJobsResult", message, {
          maxScrolls: message.maxScrolls || 100,
          scrollDelay: message.scrollDelay || 1200,
          minScore: message.minScore || 0,
          keyword: message.keyword || "",
          city: message.city || ""
        }, 900000);
        return;
      case "jobCopilotOneClickScan":
        await forwardBridgeCommand("startOneClickScan", "jobCopilotOneClickScanResult", message, {
          config: {
            maxPages: message.maxPages || 100,
            scrollDelay: message.scrollDelay || 1200,
            minScore: message.minScore || 0,
            keyword: message.keyword || "",
            city: message.city || ""
          }
        }, 900000);
        return;
      case "jobCopilotScanStatus":
        await forwardBridgeCommand("getOneClickScanStatus", "jobCopilotScanStatusResult", message, {}, 10000);
        return;
      case "jobCopilotSetAutoMode":
        await forwardBridgeCommand("setAutoMode", "jobCopilotSetAutoModeResult", message, {
          config: message.config || {}
        }, 15000);
        return;
      case "jobCopilotGetAutoModeStatus":
        await handleAutoModeStatusRequest(message);
        return;
      case "jobCopilotBatchAutoSend":
        await forwardBridgeCommand("batchAutoSendAll", "jobCopilotBatchAutoSendResult", message, {
          config: {
            maxItems: message.maxItems || 0,
            waitBetweenMs: message.waitBetweenMs || 1500
          }
        }, 1800000);
        return;
      case "jobCopilotBatchAutoSendStatus":
        await forwardBridgeCommand("getBatchAutoSendStatus", "jobCopilotBatchAutoSendStatusResult", message, {}, 10000);
        return;
      case "jobCopilotBatchAutoSendCancel":
        await forwardBridgeCommand("cancelBatchAutoSend", "jobCopilotBatchAutoSendCancelResult", message, {}, 10000);
        return;
      case "jobCopilotBridgeDebug":
        await handleBridgeDebugRequest(message);
        return;
      default:
        return;
    }
  }

  async function forwardBridgeCommand(commandType, resultType, message, payload, timeoutMs) {
    const requestId = String(message && message.requestId || "");
    try {
      const result = await sendBridgeCommand(commandType, payload || {}, timeoutMs || 20000);
      postPageMessage(resultType, requestId, result || {});
    } catch (error) {
      postPageMessage(resultType, requestId, {
        ok: false,
        error: error && error.message ? error.message : "扩展后台不可用"
      });
    }
  }

  async function handleAutoModeStatusRequest(message) {
    const requestId = String(message && message.requestId || "");
    try {
      const result = await sendBridgeCommand("getAutoModeStatus", {}, 10000);
      postPageMessage("jobCopilotGetAutoModeStatusResult", requestId, result || {});
      return;
    } catch (error) {}

    chrome.storage.local.get(["autoModeState"], function(response) {
      if (chrome.runtime.lastError) {
        postPageMessage("jobCopilotGetAutoModeStatusResult", requestId, {
          ok: false,
          error: chrome.runtime.lastError.message || "扩展后台状态不可用"
        });
        return;
      }
      const currentState = response && response.autoModeState ? response.autoModeState : {
        enabled: false,
        phase: "idle",
        totalProcessed: 0,
        totalChatted: 0
      };
      postPageMessage("jobCopilotGetAutoModeStatusResult", requestId, {
        ok: true,
        state: currentState
      });
    });
  }

  function sendBridgeCommand(commandType, payload, timeoutMs) {
    const bridgeClient = globalThis.jobCopilotBridgeClient;
    if (!bridgeClient || typeof bridgeClient.sendCommand !== "function") {
      return Promise.reject(new Error("扩展桥接客户端未加载"));
    }
    return bridgeClient.sendCommand(commandType, payload || {}, { timeoutMs: timeoutMs || 15000 });
  }

  function postPageMessage(type, requestId, payload) {
    window.postMessage({
      type: type,
      requestId: requestId,
      ...(payload || {})
    }, window.location.origin);
  }

  function handleBridgeDebugRequest(message) {
    const requestId = String(message && message.requestId || "");
    chrome.runtime.sendMessage({ type: "bridgeWakeup", requestId: requestId }, function(runtimeResponse) {
      const runtimeWakeup = chrome.runtime.lastError ? {
        ok: false,
        error: chrome.runtime.lastError.message || "后台未响应"
      } : {
        ok: !!(runtimeResponse && runtimeResponse.ok),
        response: runtimeResponse || null
      };

      chrome.storage.local.get(null, function(storagePayload) {
        if (chrome.runtime.lastError) {
          postPageMessage("jobCopilotBridgeDebugResult", requestId, {
            ok: false,
            error: chrome.runtime.lastError.message || "扩展存储不可用",
            runtimeWakeup: runtimeWakeup
          });
          return;
        }
        const allEntries = storagePayload || {};
        const bridgeEntries = Object.keys(allEntries).filter(function(storageKey) {
          return storageKey.indexOf("jobCopilotBridge") === 0 || storageKey === "autoModeState" || storageKey === "jobCopilotLastBackgroundMessage";
        }).reduce(function(result, storageKey) {
          result[storageKey] = allEntries[storageKey];
          return result;
        }, {});
        postPageMessage("jobCopilotBridgeDebugResult", requestId, {
          ok: true,
          version: BRIDGE_SCRIPT_VERSION,
          manifestVersion: chrome.runtime.getManifest().version,
          runtimeId: chrome.runtime.id,
          runtimeWakeup: runtimeWakeup,
          entries: bridgeEntries
        });
      });
    });
  }

  window.postMessage({
    type: "jobCopilotBridgeReady",
    version: BRIDGE_SCRIPT_VERSION
  }, window.location.origin);
})();

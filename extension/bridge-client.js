// 功能目的：为内容脚本提供稳定的后台请求桥；实现原因：Edge 中 runtime.sendMessage 在当前场景下会偶发无响应，需改为基于 storage 的请求应答通道。
(function installJobCopilotBridgeClient(globalScope) {
  const BRIDGE_REQUEST_KEY_PREFIX = "jobCopilotBridgeRequest:";
  const BRIDGE_RESULT_KEY_PREFIX = "jobCopilotBridgeResult:";
  const DEFAULT_TIMEOUT_MS = 15000;
  const BRIDGE_STORAGE_TTL_MS = 5 * 60 * 1000;

  if (globalScope.jobCopilotBridgeClient) {
    return;
  }

  function buildBridgeRequestId() {
    return "bridge-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function buildBridgeRequestKey(requestId) {
    return BRIDGE_REQUEST_KEY_PREFIX + String(requestId || "");
  }

  function buildBridgeResultKey(requestId) {
    return BRIDGE_RESULT_KEY_PREFIX + String(requestId || "");
  }

  function cleanupBridgeStorage(requestId) {
    const requestKey = buildBridgeRequestKey(requestId);
    const resultKey = buildBridgeResultKey(requestId);
    try {
      chrome.storage.local.remove([requestKey, resultKey], function() {});
    } catch (error) {}
  }

  function cleanupExpiredBridgeStorage(done) {
    try {
      chrome.storage.local.get(null, function(storagePayload) {
        const now = Date.now();
        const removeKeys = [];
        Object.keys(storagePayload || {}).forEach(function(storageKey) {
          const value = storagePayload[storageKey];
          if (!storageKey.startsWith(BRIDGE_REQUEST_KEY_PREFIX) && !storageKey.startsWith(BRIDGE_RESULT_KEY_PREFIX)) {
            return;
          }
          const createdAt = Number(value && (value.createdAt || value.updatedAt) || 0);
          if (!createdAt || now - createdAt > BRIDGE_STORAGE_TTL_MS) {
            removeKeys.push(storageKey);
          }
        });
        if (removeKeys.length === 0) {
          done();
          return;
        }
        chrome.storage.local.remove(removeKeys, done);
      });
    } catch (error) {
      done();
    }
  }

  function safeBridgeStorageSet(payload, done) {
    chrome.storage.local.set(payload, function() {
      const firstError = chrome.runtime.lastError;
      if (!firstError) {
        done();
        return;
      }
      const message = String(firstError.message || "").toLowerCase();
      if (!message.includes("quota") && !message.includes("kquotabytes")) {
        done(firstError);
        return;
      }
      cleanupExpiredBridgeStorage(function() {
        chrome.storage.local.set(payload, function() {
          done(chrome.runtime.lastError || null);
        });
      });
    });
  }

  function wakeBackgroundWorker(requestId) {
    try {
      chrome.runtime.sendMessage({
        type: "bridgeWakeup",
        requestId: String(requestId || "")
      }, function() {
        void chrome.runtime.lastError;
      });
    } catch (error) {}
  }

  function sendCommand(commandType, payload, options) {
    return new Promise(function(resolve, reject) {
      const requestId = buildBridgeRequestId();
      const requestKey = buildBridgeRequestKey(requestId);
      const resultKey = buildBridgeResultKey(requestId);
      const timeoutMs = Math.max(1000, Number(options && options.timeoutMs) || DEFAULT_TIMEOUT_MS);
      let finished = false;
      const timeoutId = globalScope.setTimeout(function() {
        finish(new Error("扩展后台响应超时，请稍后重试"));
      }, timeoutMs);

      function finish(error, result) {
        if (finished) {
          return;
        }
        finished = true;
        globalScope.clearTimeout(timeoutId);
        chrome.storage.onChanged.removeListener(handleStorageChange);
        cleanupBridgeStorage(requestId);
        if (error) {
          reject(error);
          return;
        }
        resolve(result || {});
      }

      function handleStorageChange(changes, areaName) {
        if (areaName !== "local" || !changes || !changes[resultKey] || !changes[resultKey].newValue) {
          return;
        }

        const result = changes[resultKey].newValue;
        if (String(result.requestId || "") !== requestId) {
          return;
        }
        if (result.ok === false) {
          finish(new Error(String(result.error || "扩展后台执行失败")));
          return;
        }
        finish(null, result);
      }

      chrome.storage.onChanged.addListener(handleStorageChange);
      chrome.storage.local.remove([resultKey], function() {
        safeBridgeStorageSet({
          [requestKey]: {
            requestId: requestId,
            type: String(commandType || ""),
            createdAt: Date.now(),
            ...(payload || {})
          }
        }, function(error) {
          if (error) {
            finish(new Error(error.message || "扩展后台不可用"));
            return;
          }
          wakeBackgroundWorker(requestId);
        });
      });
    });
  }

  globalScope.jobCopilotBridgeClient = {
    sendCommand: sendCommand,
    buildRequestKey: buildBridgeRequestKey,
    buildResultKey: buildBridgeResultKey,
    cleanup: cleanupBridgeStorage
  };
})(globalThis);

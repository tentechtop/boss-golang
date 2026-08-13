(function initializeAutoRefillPolicy(root) {
  "use strict";

  const AUTO_REFILL_RETRY_MS = 10 * 1000;
  const AUTO_POST_JOB_DELAY_MIN_MS = 6 * 1000;
  const AUTO_POST_JOB_DELAY_MAX_MS = 10 * 1000;
  const AUTO_TRANSIENT_RETRY_MIN_MS = 20 * 1000;
  const AUTO_TRANSIENT_RETRY_MAX_MS = 35 * 1000;

  // The queue must be empty before another full BOSS scan starts.
  function resolveRetryDelay(enabled, hasNextQueueItem) {
    if (enabled !== true || hasNextQueueItem === true) {
      return -1;
    }
    return AUTO_REFILL_RETRY_MS;
  }

  function shouldRunConcurrentScan(enabled, hasCurrentQueueItem, lastScanTime, now) {
    if (enabled !== true || hasCurrentQueueItem !== true) {
      return false;
    }
    const currentTime = Math.max(0, Number(now) || Date.now());
    const previousScanTime = Math.max(0, Number(lastScanTime) || 0);
    return currentTime - previousScanTime >= AUTO_REFILL_RETRY_MS;
  }

  function resolvePacedDelay(minDelayMs, maxDelayMs, randomValue) {
    const normalizedMin = Math.max(0, Math.floor(Number(minDelayMs) || 0));
    const normalizedMax = Math.max(normalizedMin, Math.floor(Number(maxDelayMs) || normalizedMin));
    const normalizedRandom = Math.min(1, Math.max(0, Number(randomValue) || 0));
    return normalizedMin + Math.floor((normalizedMax - normalizedMin) * normalizedRandom);
  }

  function resolvePostChatDelay(status, randomValue) {
    if (String(status || "") === "stopped") {
      return resolvePacedDelay(AUTO_TRANSIENT_RETRY_MIN_MS, AUTO_TRANSIENT_RETRY_MAX_MS, randomValue);
    }
    return resolvePacedDelay(AUTO_POST_JOB_DELAY_MIN_MS, AUTO_POST_JOB_DELAY_MAX_MS, randomValue);
  }

  // BOSS 页面在跳转或渲染异常时可能丢失内容脚本的完成回执；
  // 看门狗必须晚于聊天超时，确保后台可以回收卡住的队列项。
  function resolveAutoChatWatchdogDelay(autoChatTimeoutMs) {
    const timeout = Math.max(1000, Math.floor(Number(autoChatTimeoutMs) || 0));
    return timeout + 1000;
  }

  const policy = Object.freeze({
    AUTO_REFILL_RETRY_MS,
    AUTO_POST_JOB_DELAY_MIN_MS,
    AUTO_POST_JOB_DELAY_MAX_MS,
    AUTO_TRANSIENT_RETRY_MIN_MS,
    AUTO_TRANSIENT_RETRY_MAX_MS,
    resolveRetryDelay,
    shouldRunConcurrentScan,
    resolvePacedDelay,
    resolvePostChatDelay,
    resolveAutoChatWatchdogDelay
  });

  root.JobCopilotAutoRefillPolicy = policy;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = policy;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

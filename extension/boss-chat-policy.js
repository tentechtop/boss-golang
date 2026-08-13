(function initializeBossChatPolicy(root) {
  "use strict";

  const AUTO_REPLY_QUEUE_STATUSES = new Set(["delivered", "opened", "filled", "chatting"]);

  function normalizeMatchText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s（）()【】\[\]·._\-—/\\]+/g, "")
      .replace(/有限公司|有限责任公司|股份有限公司/g, "");
  }

  // 明确拒绝和停止招聘的会话不自动回复，避免对终态消息继续追问；猎头仍按 HR 消息处理。
  function shouldSkipConversation(context) {
    const details = [
      context && context.role,
      context && context.title,
      context && context.preview
    ].map(normalizeMatchText).join("|");
    return /不招了|停止招聘|已停止招聘|职位已关闭|岗位已关闭|已招到|不太适合|不合适|暂不合适|不匹配|不完全一致|不符合|很遗憾|祝您找到|祝您在boss|已发送给boss|附件简历.*已发送/.test(details);
  }

  function findMatchingQueueItem(items, context) {
    const company = normalizeMatchText(context && context.company);
    const title = normalizeMatchText(context && context.title);
    let selectedItem = null;
    let selectedScore = 0;

    (Array.isArray(items) ? items : []).forEach(function(item) {
      if (!item || !AUTO_REPLY_QUEUE_STATUSES.has(normalizeMatchText(item.status))) {
        return;
      }

      const itemCompany = normalizeMatchText(item.company);
      const itemTitle = normalizeMatchText(item.title);
      let score = 0;
      let companyMatched = false;
      if (company && itemCompany) {
        if (company === itemCompany) {
          score += 80;
          companyMatched = true;
        } else if (company.length >= 4 && itemCompany.length >= 4 && (company.includes(itemCompany) || itemCompany.includes(company))) {
          score += 45;
          companyMatched = true;
        }
      }
      if (title && itemTitle) {
        if (title === itemTitle) {
          score += 70;
        } else if (title.length >= 5 && itemTitle.length >= 5 && (title.includes(itemTitle) || itemTitle.includes(title))) {
          score += 35;
        }
      }
      if ((!company || companyMatched) && score > selectedScore) {
        selectedItem = item;
        selectedScore = score;
      }
    });

    return selectedScore >= 45 ? selectedItem : null;
  }

  // 只收集候选人上次发言后 HR 连续发送的消息，确保本轮多个问题不会只处理最后一条。
  function collectPendingRecruiterMessages(messages) {
    const normalizedMessages = (Array.isArray(messages) ? messages : []).map(function(message) {
      return {
        role: String(message && message.role || "").trim().toLowerCase(),
        content: String(message && message.content || "").trim()
      };
    }).filter(function(message) {
      return message.content !== "";
    });

    let lastCandidateIndex = -1;
    normalizedMessages.forEach(function(message, index) {
      if (message.role === "candidate") {
        lastCandidateIndex = index;
      }
    });

    return normalizedMessages.slice(lastCandidateIndex + 1).filter(function(message) {
      return message.role === "recruiter";
    });
  }

  // BOSS 点击沟通后可能先自动发送平台招呼，再展示微信订阅弹窗；该弹窗代表投递已经成功。
  function isOpeningSentDialogText(value) {
    const text = String(value || "").replace(/\s+/g, "");
    return text.includes("已发送") && (
      text.includes("订阅回复消息") ||
      /微信.*扫码.*订阅/.test(text)
    );
  }

  // 同一岗位的多路启动指令只执行一次；若页面残留其他岗位状态，则替换为最新任务。
  function resolveAutoChatStartDecision(status, currentQueueItemId, startingQueueItemId, requestedQueueItemId) {
    const current = String(currentQueueItemId || "");
    const starting = String(startingQueueItemId || "");
    const requested = String(requestedQueueItemId || "");
    if (requested && (starting === requested || (status === "chatting" && current === requested))) {
      return "ignore";
    }
    if (status === "chatting" && current !== requested) {
      return "replace";
    }
    return "start";
  }

  const policy = Object.freeze({
    normalizeMatchText,
    shouldSkipConversation,
    findMatchingQueueItem,
    collectPendingRecruiterMessages,
    isOpeningSentDialogText,
    resolveAutoChatStartDecision
  });

  root.JobCopilotBossChatPolicy = policy;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = policy;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

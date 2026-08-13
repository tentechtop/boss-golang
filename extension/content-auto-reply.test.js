const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const contentSource = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const popupSource = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

test("automatic resume sending defaults to enabled unless explicitly disabled", () => {
  const configStart = contentSource.indexOf("function loadAutoResumeReplyConfig()");
  const configEnd = contentSource.indexOf("function applyAutoResumeReplyConfig", configStart);
  const configSource = contentSource.slice(configStart, configEnd);

  assert.match(configSource, /result\.autoSendResume !== false/);
  assert.match(configSource, /applyAutoResumeReplyConfig\(\{ enabled: true \}\)/);
  assert.match(popupSource, /checkbox\.checked = !data \|\| data\.autoSendResume !== false/);
});

test("HR new-message replies are not stopped by a round limit", () => {
  assert.doesNotMatch(contentSource, /hasReachedAutoChatRoundLimit/);
  assert.doesNotMatch(contentSource, /roundCount\s*>=\s*context\.maxRounds/);
  assert.doesNotMatch(contentSource, /10\s*分钟内已发送.*自动聊天已暂停/);
});

test("the HR reply monitor pauses for platform verification", () => {
  const monitorStart = contentSource.indexOf("async function codexAutoReplyTick()");
  const monitorEnd = contentSource.indexOf("async function selectNextUnreadConversationForCodexReply()", monitorStart);
  const monitorSource = contentSource.slice(monitorStart, monitorEnd);

  assert.match(monitorSource, /detectBossInterruption\(\)/);
  assert.match(monitorSource, /自动操作已暂停，请完成平台验证后继续/);
});

test("resume requests select the whole BOSS resume row and require confirmed delivery", () => {
  const resumeDialogStart = contentSource.indexOf("async function chooseFirstResumeIfDialogVisible()");
  const resumeDialogEnd = contentSource.indexOf("function startCodexAutoReplyLoopWhenReady()", resumeDialogStart);
  const resumeDialogSource = contentSource.slice(resumeDialogStart, resumeDialogEnd);

  assert.match(resumeDialogSource, /querySelector\("\.resume-list \.list-item"\)/);
  assert.doesNotMatch(resumeDialogSource, /querySelector\("\.resume-list \.list-item \.item-body/);
  assert.match(resumeDialogSource, /return \{ ok: false, error: "未打开简历选择弹窗" \}/);
});

test("BOSS resume sent confirmations prevent duplicate delivery and allow Codex to continue", () => {
  const confirmationStart = contentSource.indexOf("function isResumeSentConfirmationText(text)");
  const confirmationEnd = contentSource.indexOf("function isResumeButtonLikeElement", confirmationStart);
  const confirmationSource = contentSource.slice(confirmationStart, confirmationEnd);
  const sendStart = contentSource.indexOf("async function sendResumeForCodexConversation");
  const sendEnd = contentSource.indexOf("function findLatestResumeConsentButton", sendStart);
  const sendSource = contentSource.slice(sendStart, sendEnd);

  assert.match(confirmationSource, /您的附件简历/);
  assert.match(confirmationSource, /已发送给boss/);
  assert.match(sendSource, /hasResumeSentConfirmationInCurrentConversation\(\)/);
  assert.match(sendSource, /return \{ ok: true, alreadySent: true \}/);
  assert.match(contentSource, /isResumeRequestText\(rightPreview\) \|\| isResumeSentConfirmationText\(rightPreview\)/);
});

test("BOSS conversation status previews cannot block real HR messages", () => {
  const monitorStart = contentSource.indexOf("async function codexAutoReplyTick()");
  const monitorEnd = contentSource.indexOf("function readCodexConversationRowContext", monitorStart);
  const monitorSource = contentSource.slice(monitorStart, monitorEnd);

  assert.match(monitorSource, /isBossConversationSystemPreview\(previewText\)/);
  assert.match(monitorSource, /\^您正在与boss\.\{0,80\}沟通\$/i);
  assert.match(monitorSource, /codexAutoReplyPendingConversation\.selectedAt/);
  assert.match(monitorSource, /> 8000/);
  assert.match(monitorSource, /clearCodexAutoReplyPendingConversation\(1, 2\)/);
});

test("Codex does not claim a resume was sent when BOSS delivery failed", () => {
  const monitorStart = contentSource.indexOf("async function codexAutoReplyTick()");
  const monitorEnd = contentSource.indexOf("async function selectNextUnreadConversationForCodexReply()", monitorStart);
  const monitorSource = contentSource.slice(monitorStart, monitorEnd);
  const failureGuardIndex = monitorSource.indexOf("if (!resumeResult.ok)");
  const replyApiIndex = monitorSource.indexOf('requestLocalJSON("/api/chat/auto/reply"');

  assert.ok(failureGuardIndex >= 0, "resume delivery failure guard is required");
  assert.ok(failureGuardIndex < replyApiIndex, "resume delivery must succeed before generating a sent-confirmation reply");
  assert.match(monitorSource, /codexAutoReplyProcessedKeys\.delete\(messageKey\)/);
  assert.match(monitorSource, /codexAutoReplyNextActionAt = Date\.now\(\) \+ 10 \* 1000/);
});

test("automatic replies accept Codex, DeepSeek, Zhipu, and fixed-template generators", () => {
  const monitorStart = contentSource.indexOf("async function codexAutoReplyTick()");
  const monitorEnd = contentSource.indexOf("async function selectNextUnreadConversationForCodexReply()", monitorStart);
  const monitorSource = contentSource.slice(monitorStart, monitorEnd);

  assert.match(monitorSource, /\["codex", "deepseek", "zhipu", "fixed_template"\]\.includes\(replyGenerator\)/);
  assert.doesNotMatch(monitorSource, /suggestion && suggestion\.generator\) !== "codex"/);
});

test("an unanswered BOSS navigation has an automatic chat watchdog", () => {
  const processStart = backgroundSource.indexOf("async function processOneQueueItem(item)");
  const processEnd = backgroundSource.indexOf("async function ensureAutoQueueItemPrepared", processStart);
  const processSource = backgroundSource.slice(processStart, processEnd);

  assert.match(processSource, /resolveAutoChatWatchdogDelay\(AUTO_CHAT_TIMEOUT_MS\)/);
  assert.match(processSource, /queueAutoModeCycle\(/);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("./boss-chat-policy.js");

test("a delivered queue item matches the active BOSS company", () => {
  const matched = policy.findMatchingQueueItem([
    { id: "one", company: "四川人瑞", title: "后端开发（Go/Java）", status: "delivered" },
    { id: "two", company: "枫叶互动", title: "Go 后端开发工程师", status: "delivered" }
  ], { company: "四川人瑞", title: "后端开发 Go/Java" });

  assert.equal(matched && matched.id, "one");
});

test("unrelated and unfinished queue items are not selected", () => {
  assert.equal(policy.findMatchingQueueItem([
    { id: "queued", company: "四川人瑞", title: "后端开发", status: "prepared" },
    { id: "other", company: "其他公司", title: "后端开发", status: "delivered" }
  ], { company: "四川人瑞", title: "后端开发" }), null);
});

test("headhunter messages are eligible while terminal recruiter messages are skipped", () => {
  assert.equal(policy.shouldSkipConversation({ role: "猎头顾问", preview: "期望薪资多少" }), false);
  assert.equal(policy.shouldSkipConversation({ role: "招聘者", preview: "这个岗位不招了" }), true);
  assert.equal(policy.shouldSkipConversation({ role: "HR", preview: "很遗憾不能与您共事，祝您找到更匹配的工作" }), true);
	assert.equal(policy.shouldSkipConversation({ role: "HR", preview: "您的附件简历已发送给Boss" }), true);
  assert.equal(policy.shouldSkipConversation({ role: "HRBP", preview: "目前还在看机会吗" }), false);
});

test("all consecutive recruiter questions after the latest candidate reply are pending", () => {
  const pendingMessages = policy.collectPendingRecruiterMessages([
    { role: "recruiter", content: "学历是本科吗？" },
    { role: "candidate", content: "是的，本科。" },
    { role: "recruiter", content: "Go 做了几年？" },
    { role: "recruiter", content: "做过支付结算吗？" },
    { role: "recruiter", content: "发一份简历吧" }
  ]);

  assert.deepEqual(pendingMessages.map((message) => message.content), [
    "Go 做了几年？",
    "做过支付结算吗？",
    "发一份简历吧"
  ]);
});

test("the BOSS reply subscription dialog confirms that the opening was sent", () => {
  assert.equal(policy.isOpeningSentDialogText("已发送\n您好，对贵公司很感兴趣，希望能和您聊聊\n订阅回复消息\n使用微信扫码订阅"), true);
  assert.equal(policy.isOpeningSentDialogText("订阅回复消息\n使用微信扫码订阅"), false);
  assert.equal(policy.isOpeningSentDialogText("消息已发送"), false);
});

test("duplicate auto chat startup for the same queue item is ignored", () => {
  assert.equal(policy.resolveAutoChatStartDecision("idle", "", "queue-one", "queue-one"), "ignore");
  assert.equal(policy.resolveAutoChatStartDecision("chatting", "queue-one", "", "queue-one"), "ignore");
});

test("a stale chatting task is replaced by the requested queue item", () => {
  assert.equal(policy.resolveAutoChatStartDecision("chatting", "queue-old", "", "queue-new"), "replace");
});

test("an idle auto chat task starts immediately", () => {
  assert.equal(policy.resolveAutoChatStartDecision("idle", "", "", "queue-new"), "start");
});

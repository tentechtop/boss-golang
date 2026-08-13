const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("./auto-refill-policy.js");

test("enabled automation retries when the queue is empty", () => {
  assert.equal(policy.resolveRetryDelay(true, false), 10_000);
});

test("disabled automation does not schedule a refill", () => {
  assert.equal(policy.resolveRetryDelay(false, false), -1);
});

test("an existing queue item is processed before another scan", () => {
  assert.equal(policy.resolveRetryDelay(true, true), -1);
});

test("job scanning continues every ten seconds while another job is chatting", () => {
  assert.equal(policy.shouldRunConcurrentScan(true, true, 90_000, 100_000), true);
  assert.equal(policy.shouldRunConcurrentScan(true, true, 91_000, 100_000), false);
  assert.equal(policy.shouldRunConcurrentScan(true, false, 0, 100_000), false);
});

test("completed jobs wait before the next job", () => {
  assert.equal(policy.resolvePostChatDelay("completed", 0), 6_000);
  assert.equal(policy.resolvePostChatDelay("completed", 1), 10_000);
});

test("transient chat failures use a longer retry delay", () => {
  assert.equal(policy.resolvePostChatDelay("stopped", 0), 20_000);
  assert.equal(policy.resolvePostChatDelay("stopped", 1), 35_000);
});

test("a missing BOSS callback is recovered after the chat timeout", () => {
  assert.equal(policy.resolveAutoChatWatchdogDelay(45_000), 46_000);
});

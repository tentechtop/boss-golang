const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
const accessibilitySource = fs.readFileSync(path.join(__dirname, "..", "web", "accessibility.js"), "utf8");

test("the first-screen automatic delivery form exposes selectable Codex, DeepSeek, and Zhipu settings", () => {
  const autoApplyStart = indexSource.indexOf('id="accessibleAutoApplyButton"');
  const aiSettingsStart = indexSource.indexOf('class="ai-reply-setup"');
  const advancedModeStart = indexSource.indexOf("持续自动模式");

  assert.ok(autoApplyStart >= 0, "the first-screen automatic delivery form is required");
  assert.ok(aiSettingsStart > autoApplyStart, "AI reply settings must appear in the first-screen form");
  assert.ok(aiSettingsStart < advancedModeStart, "AI reply settings must not be hidden in the advanced section");
  assert.equal((indexSource.match(/id="deepSeekApiKey"/g) || []).length, 1);
  assert.equal((indexSource.match(/id="zhipuApiKey"/g) || []).length, 1);
  assert.match(indexSource, /id="aiReplyProvider"/);
  assert.match(indexSource, /value="codex"/);
  assert.match(indexSource, /value="deepseek"/);
  assert.match(indexSource, /value="zhipu"/);
  assert.match(indexSource, /id="accessibleSaveAIReplySettingsButton"/);
});

test("provider-specific fields toggle and automatic delivery saves reply settings", () => {
  assert.match(appSource, /deepSeekSettings\.hidden = providerInput\.value !== "deepseek"/);
  assert.match(appSource, /zhipuSettings\.hidden = providerInput\.value !== "zhipu"/);
  assert.match(appSource, /deepSeekApiKey: deepSeekAPIKey/);
  assert.match(appSource, /zhipuApiKey: zhipuAPIKey/);
  assert.match(appSource, /provider,/);
  assert.match(accessibilitySource, /await saveAccessibleAIReplySettings\(false\)/);
  assert.match(accessibilitySource, /saveAccessibleAIReplySettings\(true\)/);
});

test("a blank maximum salary keeps only the minimum salary filter", () => {
  assert.match(indexSource, /最高月薪\(K，可留空\)/);
  assert.match(indexSource, /留空后只过滤低于最低月薪的岗位/);
  assert.match(accessibilitySource, /maxSalaryK: readNumberValue\("accessibleMaxSalary", DEFAULT_MAX_SALARY_K, 0, 300\)/);
  assert.match(appSource, /maxSalaryK: readNumber\("strategyMaxSalaryInput", 0, 0, 300\)/);
  assert.doesNotMatch(appSource, /FIXED_MAX_SALARY_K/);
});

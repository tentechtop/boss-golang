const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("./boss-search-policy.js");

test("25K to 35K uses the narrowest available BOSS salary band", () => {
  assert.deepEqual(policy.resolveSalaryBand(25, 35), {
    code: "406",
    label: "20-50K",
    minK: 20,
    maxK: 50
  });
});

test("a minimum-only salary target leaves BOSS salary unrestricted", () => {
  assert.equal(policy.resolveSalaryBand(25, 0), null);
});

test("an unsupported cross-band salary range leaves BOSS salary unrestricted", () => {
  assert.equal(policy.resolveSalaryBand(15, 25), null);
});

test("golang backend resolves to the verified BOSS Golang position", () => {
  assert.deepEqual(policy.resolvePosition("Go 后端工程师"), {
    code: "100116",
    label: "Golang",
    category: "互联网/AI",
    keywords: ["golang", "go语言", "go后端"]
  });
  assert.equal(policy.resolvePosition("Java 后端"), null);
});

test("normal jobs default to full time while internships stay unrestricted", () => {
  assert.deepEqual(policy.resolveJobType("golang后端"), { code: "1901", label: "全职" });
  assert.deepEqual(policy.resolveJobType("Golang兼职"), { code: "1903", label: "兼职" });
  assert.equal(policy.resolveJobType("Golang实习"), null);
});

test("continuous mode dispatches as soon as a new page batch is found", () => {
  assert.equal(policy.shouldStopAfterNewBatch(true, 4), true);
  assert.equal(policy.shouldStopAfterNewBatch(true, 0), false);
  assert.equal(policy.shouldStopAfterNewBatch(false, 4), false);
  assert.deepEqual(policy.selectNextJobBatch([{ id: 1 }, { id: 2 }], true), [{ id: 1 }]);
  assert.deepEqual(policy.selectNextJobBatch([{ id: 1 }, { id: 2 }], false), [{ id: 1 }, { id: 2 }]);
});

test("the persisted automation tab is reused before another BOSS tab", () => {
  const tabs = [
    { id: 11, url: "https://www.zhipin.com/web/geek/jobs" },
    { id: 22, url: "https://www.zhipin.com/job_detail/example.html" }
  ];

  assert.equal(policy.selectReusableBossTab(tabs, 22).id, 22);
});

test("a jobs tab is preferred when the persisted tab no longer exists", () => {
  const tabs = [
    { id: 22, url: "https://www.zhipin.com/job_detail/example.html" },
    { id: 11, url: "https://www.zhipin.com/web/geek/jobs" }
  ];

  assert.equal(policy.selectReusableBossTab(tabs, 99).id, 11);
});

test("explicit closed job statuses are recognized", () => {
  assert.equal(policy.isClosedJobStatusText("职位已关闭"), true);
  assert.equal(policy.isClosedJobStatusText(" 岗位已下线。 "), true);
  assert.equal(policy.isClosedJobStatusText("招聘者已停止招聘"), true);
});

test("ordinary text mentioning closed jobs is not treated as a closed status", () => {
  assert.equal(policy.isClosedJobStatusText("查看已关闭职位"), false);
  assert.equal(policy.isClosedJobStatusText("该岗位关闭后可以查看其他职位"), false);
  assert.equal(policy.isClosedJobStatusText("职位招聘中"), false);
});

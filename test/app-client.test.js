const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntime } = require("../public/app.js");

function createFakeElements() {
  return {
    form: {
      addEventListener() {},
    },
    promptInput: {
      value: "真实摄影测试提示词",
      disabled: false,
      focusCalled: false,
      addEventListener() {},
      focus() {
        this.focusCalled = true;
      },
    },
    submitButton: {
      disabled: false,
      textContent: "生成图像",
      dataset: {},
    },
    root: {
      dataset: {},
    },
    statusText: {
      textContent: "",
    },
    queueValue: {
      textContent: "",
    },
    progressWrap: {
      hidden: true,
    },
    progressFill: {
      style: {
        width: "0%",
      },
    },
    progressText: {
      textContent: "",
    },
    errorText: {
      textContent: "",
      hidden: true,
    },
    image: {
      src: "",
      alt: "",
      hidden: true,
    },
    characterCount: {
      textContent: "",
    },
    promptExampleButtons: [
      {
        dataset: {
          prompt:
            "电影级真实摄影：雨后东京街角的一家深夜拉面店，玻璃窗上有细密水珠和霓虹倒影，一位穿深色风衣的年轻女性坐在靠窗位置，手边是一碗热气升腾的拉面，环境光来自红蓝霓虹与暖色店灯，浅景深，35mm 镜头，真实皮肤质感，胶片颗粒，高动态范围，杂志封面级构图",
        },
        addEventListener(_eventName, callback) {
          this.click = callback;
        },
      },
    ],
    sizePresetInputs: [
      { value: "square", checked: false },
      { value: "portrait", checked: true },
      { value: "landscape", checked: false },
    ],
  };
}

test("client runtime sends sizePreset, shows queueCount, and unlocks after terminal failure", async () => {
  const elements = createFakeElements();
  const intervalCalls = [];
  let nowValue = 1_000;
  const requests = [];
  const responses = [
    {
      ok: true,
      status: 202,
      json: async () => ({
        jobId: "job-1",
        status: "queued",
        queuePosition: 1,
        queueCount: 3,
        queuedCount: 1,
        runningCount: 2,
      }),
    },
    {
      ok: true,
      status: 200,
      json: async () => ({
        status: "failed",
        queuePosition: 0,
        queueCount: 2,
        queuedCount: 0,
        runningCount: 2,
        error: "upstream failed",
      }),
    },
  ];

  const runtime = createRuntime({
    elements,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    nowImpl: () => nowValue,
    setIntervalImpl: (callback, ms) => {
      intervalCalls.push({ callback, ms });
      return intervalCalls.length;
    },
    clearIntervalImpl() {},
  });

  await runtime.handleSubmit({ preventDefault() {} });

  assert.equal(requests[0].url, "/api/jobs");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    prompt: "真实摄影测试提示词",
    sizePreset: "portrait",
  });
  assert.equal(elements.promptInput.disabled, true);
  assert.equal(elements.submitButton.disabled, true);
  assert.equal(elements.submitButton.dataset.state, "busy");
  assert.equal(elements.root.dataset.state, "queued");
  assert.equal(elements.statusText.textContent, "已排队，等待通道。");
  assert.match(elements.queueValue.textContent, /3 个任务/);
  assert.equal(elements.progressWrap.hidden, false);
  assert.equal(intervalCalls.length, 2);

  nowValue = 62_000;
  const progressTimer = intervalCalls.find((entry) => entry.ms === 1000);
  await progressTimer.callback();
  assert.match(elements.progressText.textContent, /已等待 61 秒/);
  assert.match(elements.progressText.textContent, /60-120 秒/);
  assert.notEqual(elements.progressFill.style.width, "0%");

  const jobPollTimer = intervalCalls.find((entry) => entry.ms === 2000);
  await jobPollTimer.callback();

  assert.equal(elements.promptInput.disabled, false);
  assert.equal(elements.submitButton.disabled, false);
  assert.equal(elements.submitButton.dataset.state, "ready");
  assert.equal(elements.root.dataset.state, "failed");
  assert.equal(elements.errorText.hidden, false);
  assert.match(elements.errorText.textContent, /upstream failed/i);
  assert.match(elements.queueValue.textContent, /2 个任务/);
});

test("client runtime updates prompt count and fills prompt examples", () => {
  const elements = createFakeElements();
  const runtime = createRuntime({
    elements,
    fetchImpl: async () => ({ ok: true, json: async () => ({ queueCount: 0 }) }),
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
  });

  runtime.start();
  assert.equal(elements.characterCount.textContent, "9 字");

  elements.promptExampleButtons[0].click();

  assert.equal(
    elements.promptInput.value,
    "电影级真实摄影：雨后东京街角的一家深夜拉面店，玻璃窗上有细密水珠和霓虹倒影，一位穿深色风衣的年轻女性坐在靠窗位置，手边是一碗热气升腾的拉面，环境光来自红蓝霓虹与暖色店灯，浅景深，35mm 镜头，真实皮肤质感，胶片颗粒，高动态范围，杂志封面级构图"
  );
  assert.equal(elements.characterCount.textContent, "122 字");
  assert.equal(elements.promptInput.focusCalled, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntime } = require("../public/app.js");

function createFakeElements() {
  return {
    form: {
      addEventListener() {},
    },
    promptInput: {
      value: "sharp monochrome portrait",
      disabled: false,
      focusCalled: false,
      focus() {
        this.focusCalled = true;
      },
    },
    submitButton: {
      disabled: false,
      textContent: "Generate image",
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
    sizePresetInputs: [
      { value: "square", checked: false },
      { value: "portrait", checked: false },
      { value: "story", checked: true },
      { value: "landscape", checked: false },
      { value: "widescreen", checked: false },
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
    prompt: "sharp monochrome portrait",
    sizePreset: "story",
  });
  assert.equal(elements.promptInput.disabled, true);
  assert.equal(elements.submitButton.disabled, true);
  assert.match(elements.statusText.textContent, /queued/i);
  assert.match(elements.queueValue.textContent, /total in queue 3/i);
  assert.equal(elements.progressWrap.hidden, false);
  assert.equal(intervalCalls.length, 2);

  nowValue = 62_000;
  const progressTimer = intervalCalls.find((entry) => entry.ms === 1000);
  await progressTimer.callback();
  assert.match(elements.progressText.textContent, /61s/i);
  assert.match(elements.progressText.textContent, /60-120s/i);
  assert.notEqual(elements.progressFill.style.width, "0%");

  const jobPollTimer = intervalCalls.find((entry) => entry.ms === 2000);
  await jobPollTimer.callback();

  assert.equal(elements.promptInput.disabled, false);
  assert.equal(elements.submitButton.disabled, false);
  assert.equal(elements.errorText.hidden, false);
  assert.match(elements.errorText.textContent, /upstream failed/i);
  assert.match(elements.queueValue.textContent, /total in queue 2/i);
});

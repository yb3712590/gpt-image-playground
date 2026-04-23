(function attachClient(globalObject) {
  const POLL_INTERVAL_MS = 2000;
  const PROGRESS_INTERVAL_MS = 1000;
  const QUEUE_REFRESH_MS = 4000;
  const PROGRESS_MAX_SECONDS = 120;

  function createRuntime({
    elements,
    fetchImpl = globalObject.fetch.bind(globalObject),
    nowImpl = () => Date.now(),
    setIntervalImpl = globalObject.setInterval.bind(globalObject),
    clearIntervalImpl = globalObject.clearInterval.bind(globalObject),
    documentRef = globalObject.document,
  } = {}) {
    const resolvedElements = elements || {
      form: documentRef.getElementById("prompt-form"),
      promptInput: documentRef.getElementById("prompt-input"),
      submitButton: documentRef.getElementById("submit-button"),
      statusText: documentRef.getElementById("status-text"),
      queueValue: documentRef.getElementById("queue-value"),
      progressWrap: documentRef.getElementById("progress-wrap"),
      progressFill: documentRef.getElementById("progress-fill"),
      progressText: documentRef.getElementById("progress-text"),
      errorText: documentRef.getElementById("error-text"),
      image: documentRef.getElementById("result-image"),
      placeholderText: documentRef.getElementById("placeholder-text"),
      root: documentRef.getElementById("workspace"),
      stageState: documentRef.getElementById("stage-state"),
      characterCount: documentRef.getElementById("character-count"),
      promptExampleButtons: Array.from(
        documentRef.querySelectorAll(".prompt-example")
      ),
      sizePresetInputs: Array.from(
        documentRef.querySelectorAll('input[name="size-preset"]')
      ),
    };

    let activeJobId = "";
    let activeJobStartedAt = 0;
    let jobPollHandle = null;
    let progressHandle = null;
    let queueRefreshHandle = null;

    function getSelectedSizePreset() {
      const selected = resolvedElements.sizePresetInputs.find(
        (input) => input.checked
      );
      return selected ? selected.value : "square";
    }

    function setUiState(state) {
      if (resolvedElements.root) {
        resolvedElements.root.dataset.state = state;
      }
      if (resolvedElements.stageState) {
        resolvedElements.stageState.textContent = state;
      }
    }

    function updateCharacterCount() {
      if (!resolvedElements.characterCount) {
        return;
      }
      const count = resolvedElements.promptInput.value.length;
      resolvedElements.characterCount.textContent = `${count} 字`;
    }

    function bindPromptExamples() {
      const buttons = resolvedElements.promptExampleButtons || [];
      buttons.forEach((button) => {
        button.addEventListener("click", () => {
          resolvedElements.promptInput.value = button.dataset.prompt || "";
          updateCharacterCount();
          resolvedElements.promptInput.focus();
        });
      });
    }

    function setLocked(locked) {
      resolvedElements.promptInput.disabled = locked;
      resolvedElements.submitButton.disabled = locked;
      resolvedElements.submitButton.dataset.state = locked ? "busy" : "ready";
      resolvedElements.submitButton.textContent = locked
        ? "生成中..."
        : "生成图像";
    }

    function setStatus(text) {
      resolvedElements.statusText.textContent = text;
    }

    function setQueueText(queuePosition, queueCount, status) {
      if (status === "running") {
        resolvedElements.queueValue.textContent = `${queueCount} 个任务 · 生成中`;
        return;
      }
      if (queuePosition > 0) {
        resolvedElements.queueValue.textContent = `${queueCount} 个任务 · 第 ${queuePosition} 位`;
        return;
      }
      resolvedElements.queueValue.textContent = `${queueCount} 个任务`;
    }

    function setError(message) {
      resolvedElements.errorText.textContent = message || "";
      resolvedElements.errorText.hidden = !message;
    }

    function setImage(source, prompt) {
      if (!source) {
        resolvedElements.image.src = "";
        resolvedElements.image.alt = "";
        resolvedElements.image.hidden = true;
        if (resolvedElements.placeholderText) {
          resolvedElements.placeholderText.hidden = false;
        }
        return;
      }

      resolvedElements.image.src = source;
      resolvedElements.image.alt = prompt
        ? `根据提示词生成的图像：${prompt}`
        : "生成图像";
      resolvedElements.image.hidden = false;
      if (resolvedElements.placeholderText) {
        resolvedElements.placeholderText.hidden = true;
      }
    }

    function setProgressVisible(visible) {
      resolvedElements.progressWrap.hidden = !visible;
    }

    function updateProgressText() {
      if (!activeJobStartedAt) {
        return;
      }

      const elapsedSeconds = Math.max(
        0,
        Math.floor((nowImpl() - activeJobStartedAt) / 1000)
      );
      const progress = Math.min(elapsedSeconds / PROGRESS_MAX_SECONDS, 1);

      resolvedElements.progressFill.style.width = `${(progress * 100).toFixed(1)}%`;
      resolvedElements.progressText.textContent =
        elapsedSeconds < PROGRESS_MAX_SECONDS
          ? `已等待 ${elapsedSeconds} 秒 · 通常 60-120 秒完成。`
          : `已等待 ${elapsedSeconds} 秒 · 仍在处理中。`;
    }

    async function safeJson(response) {
      try {
        return await response.json();
      } catch (_error) {
        return {};
      }
    }

    function stopJobPolling() {
      if (jobPollHandle) {
        clearIntervalImpl(jobPollHandle);
        jobPollHandle = null;
      }
    }

    function stopProgressTimer() {
      if (progressHandle) {
        clearIntervalImpl(progressHandle);
        progressHandle = null;
      }
    }

    function renderJobState(payload) {
      setQueueText(payload.queuePosition || 0, payload.queueCount || 0, payload.status);
      setUiState(payload.status || "idle");

      if (payload.status === "queued") {
        setStatus("已排队，等待通道。");
        return;
      }
      if (payload.status === "running") {
        setStatus("生成中，请稍候。");
        return;
      }
      if (payload.status === "succeeded") {
        setStatus("已完成，图像已显示。");
        setImage(payload.imageDataUrl, resolvedElements.promptInput.value.trim());
        setError("");
        setLocked(false);
        stopJobPolling();
        stopProgressTimer();
        activeJobId = "";
        return;
      }

      setStatus("生成失败。");
      setError(payload.error || "请求失败");
      setLocked(false);
      stopJobPolling();
      stopProgressTimer();
      activeJobId = "";
    }

    async function refreshQueue() {
      if (activeJobId) {
        return;
      }

      const response = await fetchImpl("/api/queue");
      const payload = await safeJson(response);
      if (response.ok) {
        setQueueText(0, payload.queueCount || 0, "idle");
      }
    }

    async function pollJob() {
      if (!activeJobId) {
        return;
      }

      const response = await fetchImpl(`/api/jobs/${activeJobId}`);
      const payload = await safeJson(response);
      if (!response.ok) {
        renderJobState({
          status: "failed",
          queueCount: payload.queueCount || 0,
          error: payload.error || "轮询失败",
          queuePosition: 0,
        });
        return;
      }

      renderJobState(payload);
    }

    async function handleSubmit(event) {
      if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }

      const prompt = resolvedElements.promptInput.value.trim();
      const sizePreset = getSelectedSizePreset();
      if (!prompt) {
        setError("提交前请先输入提示词。");
        setStatus("需要提示词。");
        setUiState("failed");
        return;
      }

      stopJobPolling();
      stopProgressTimer();
      activeJobStartedAt = 0;
      setImage("", "");
      setError("");
      setProgressVisible(false);
      resolvedElements.progressFill.style.width = "0%";
      resolvedElements.progressText.textContent = "";
      setLocked(true);
      setStatus("正在提交提示词...");
      setUiState("queued");

      const response = await fetchImpl("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, sizePreset }),
      });
      const payload = await safeJson(response);

      if (!response.ok) {
        setStatus("提交失败。");
        setQueueText(0, payload.queueCount || 0, "failed");
        setError(payload.error || "请求失败");
        setLocked(false);
        setUiState("failed");
        return;
      }

      activeJobId = payload.jobId;
      activeJobStartedAt = nowImpl();
      setProgressVisible(true);
      updateProgressText();
      renderJobState(payload);
      jobPollHandle = setIntervalImpl(() => pollJob(), POLL_INTERVAL_MS);
      progressHandle = setIntervalImpl(
        () => updateProgressText(),
        PROGRESS_INTERVAL_MS
      );
    }

    function start() {
      resolvedElements.form.addEventListener("submit", handleSubmit);
      resolvedElements.promptInput.addEventListener("input", updateCharacterCount);
      updateCharacterCount();
      bindPromptExamples();
      setUiState("idle");
      refreshQueue();
      queueRefreshHandle = setIntervalImpl(() => refreshQueue(), QUEUE_REFRESH_MS);
      return {
        stop() {
          stopJobPolling();
          stopProgressTimer();
          if (queueRefreshHandle) {
            clearIntervalImpl(queueRefreshHandle);
            queueRefreshHandle = null;
          }
        },
      };
    }

    return {
      handleSubmit,
      pollJob,
      refreshQueue,
      renderJobState,
      setLocked,
      setQueueText,
      updateProgressText,
      start,
    };
  }

  const api = {
    createRuntime,
    start(options) {
      return createRuntime(options).start();
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.ImageDemoApp = api;
})(typeof globalThis !== "undefined" ? globalThis : window);

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

    function setLocked(locked) {
      resolvedElements.promptInput.disabled = locked;
      resolvedElements.submitButton.disabled = locked;
      resolvedElements.submitButton.textContent = locked
        ? "Generating..."
        : "Generate image";
    }

    function setStatus(text) {
      resolvedElements.statusText.textContent = text;
    }

    function setQueueText(queuePosition, queueCount, status) {
      if (status === "running") {
        resolvedElements.queueValue.textContent = `Total in queue ${queueCount} · Your job is running`;
        return;
      }
      if (queuePosition > 0) {
        resolvedElements.queueValue.textContent = `Total in queue ${queueCount} · Your position ${queuePosition}`;
        return;
      }
      resolvedElements.queueValue.textContent = `Total in queue ${queueCount}`;
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
        return;
      }

      resolvedElements.image.src = source;
      resolvedElements.image.alt = prompt
        ? `Generated image for prompt: ${prompt}`
        : "Generated image";
      resolvedElements.image.hidden = false;
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
          ? `Waiting ${elapsedSeconds}s · Usually completes in 60-120s.`
          : `Waiting ${elapsedSeconds}s · Still processing.`;
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

      if (payload.status === "queued") {
        setStatus("Queued. Your prompt is waiting for a worker slot.");
        return;
      }
      if (payload.status === "running") {
        setStatus("Generating. The prompt editor stays locked until this finishes.");
        return;
      }
      if (payload.status === "succeeded") {
        setStatus("Finished. The latest image is ready below.");
        setImage(payload.imageDataUrl, resolvedElements.promptInput.value.trim());
        setError("");
        setLocked(false);
        stopJobPolling();
        stopProgressTimer();
        activeJobId = "";
        return;
      }

      setStatus("Generation failed.");
      setError(payload.error || "Request failed");
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
          error: payload.error || "Polling failed",
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
        setError("Please enter a prompt before submitting.");
        setStatus("Prompt required.");
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
      setStatus("Submitting prompt...");

      const response = await fetchImpl("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, sizePreset }),
      });
      const payload = await safeJson(response);

      if (!response.ok) {
        setStatus("Submission failed.");
        setQueueText(0, payload.queueCount || 0, "failed");
        setError(payload.error || "Request failed");
        setLocked(false);
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

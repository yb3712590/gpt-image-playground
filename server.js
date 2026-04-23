const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

const CONFIG_PATH = path.join(__dirname, "config.json");
const SESSION_COOKIE = "image_playground_session";
const JOB_POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 180000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 7654;
const DEFAULT_SIZE_PRESET = "square";
const SIZE_PRESET_TO_API_SIZE = Object.freeze({
  square: "1024x1024",
  portrait: "1024x1536",
  story: "1024x1536",
  landscape: "1536x1024",
  widescreen: "1536x1024",
});

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function normalizeHost(host) {
  return String(host ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
}

function validatePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function resolveSizePreset(sizePreset) {
  if (sizePreset == null || String(sizePreset).trim() === "") {
    return DEFAULT_SIZE_PRESET;
  }

  const normalized = String(sizePreset).trim();
  return SIZE_PRESET_TO_API_SIZE[normalized] ? normalized : null;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config.json must contain a JSON object");
  }

  const normalized = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: String(config.apiKey || "").trim(),
    host: normalizeHost(config.host),
    port: Number(config.port ?? DEFAULT_PORT),
    concurrency: Number(config.concurrency),
    rateLimitMax: Number(config.rateLimitMax),
    rateLimitWindowMinutes: Number(config.rateLimitWindowMinutes),
  };

  if (!normalized.baseUrl) {
    throw new Error("config.json is missing baseUrl");
  }
  if (!normalized.apiKey) {
    throw new Error("config.json is missing apiKey");
  }

  validatePositiveInteger(normalized.port, "port");
  validatePositiveInteger(normalized.concurrency, "concurrency");
  validatePositiveInteger(normalized.rateLimitMax, "rateLimitMax");
  validatePositiveInteger(
    normalized.rateLimitWindowMinutes,
    "rateLimitWindowMinutes"
  );

  return normalized;
}

function loadConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`config.json is not valid JSON: ${error.message}`);
  }

  return validateConfig(parsed);
}

function createState() {
  return {
    jobs: new Map(),
    pendingQueue: [],
    rateLimits: new Map(),
    activeCount: 0,
  };
}

function getPendingCount(state) {
  return state.pendingQueue.length;
}

function getQueueStats(state) {
  const queuedCount = getPendingCount(state);
  const runningCount = state.activeCount;
  return {
    queueCount: queuedCount + runningCount,
    queuedCount,
    runningCount,
  };
}

function getQueuePosition(state, job) {
  if (!job || job.status !== "queued") {
    return 0;
  }

  const index = state.pendingQueue.indexOf(job.id);
  return index === -1 ? 0 : index + 1;
}

function serializeJob(state, job) {
  const payload = {
    status: job.status,
    queuePosition: getQueuePosition(state, job),
    ...getQueueStats(state),
  };

  if (job.status === "succeeded" && job.imageDataUrl) {
    payload.imageDataUrl = job.imageDataUrl;
  }
  if (job.status === "failed" && job.error) {
    payload.error = job.error;
  }

  return payload;
}

function normalizeIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function applyRateLimit(state, req, config, nowFn) {
  const now = nowFn();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  const ip = normalizeIp(req);
  const timestamps = (state.rateLimits.get(ip) || []).filter(
    (value) => now - value < windowMs
  );

  if (timestamps.length >= config.rateLimitMax) {
    state.rateLimits.set(ip, timestamps);
    const retryAt = timestamps[0] + windowMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    };
  }

  timestamps.push(now);
  state.rateLimits.set(ip, timestamps);
  return { allowed: true };
}

async function generateImageViaApi({
  config,
  prompt,
  sizePreset = DEFAULT_SIZE_PRESET,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const resolvedSizePreset = resolveSizePreset(sizePreset) || DEFAULT_SIZE_PRESET;

  try {
    const response = await fetchImpl(
      `${normalizeBaseUrl(config.baseUrl)}/images/generations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt,
          n: 1,
          size: SIZE_PRESET_TO_API_SIZE[resolvedSizePreset],
          quality: "auto",
          background: "auto",
          output_format: "png",
        }),
        signal: controller.signal,
      }
    );

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.error || `Upstream error ${response.status}`;
      throw new Error(message);
    }

    const encodedImage = payload?.data?.[0]?.b64_json;
    if (!encodedImage) {
      throw new Error("Upstream response did not include image data");
    }

    return `data:image/png;base64,${encodedImage}`;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Image generation timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createApp({
  config,
  generateImage = (options) => generateImageViaApi(options),
  now = Date.now,
  fetchImpl = fetch,
  sessionIdFactory = () => crypto.randomUUID(),
} = {}) {
  const resolvedConfig = validateConfig(config || loadConfig());
  const state = createState();
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let sessionId = cookies[SESSION_COOKIE];
    if (!sessionId) {
      sessionId = sessionIdFactory();
      res.append(
        "Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(
          sessionId
        )}; Path=/; HttpOnly; SameSite=Lax`
      );
    }
    req.sessionId = sessionId;
    next();
  });

  function pumpQueue() {
    while (
      state.activeCount < resolvedConfig.concurrency &&
      state.pendingQueue.length > 0
    ) {
      const jobId = state.pendingQueue.shift();
      const job = state.jobs.get(jobId);
      if (!job || job.status !== "queued") {
        continue;
      }

      job.status = "running";
      job.startedAt = now();
      state.activeCount += 1;

      void Promise.resolve(
        generateImage({
          config: resolvedConfig,
          prompt: job.prompt,
          sizePreset: job.sizePreset,
          fetchImpl,
        })
      )
        .then((imageDataUrl) => {
          job.status = "succeeded";
          job.finishedAt = now();
          job.imageDataUrl = imageDataUrl;
        })
        .catch((error) => {
          job.status = "failed";
          job.finishedAt = now();
          job.error = error.message || "Image generation failed";
        })
        .finally(() => {
          state.activeCount -= 1;
          pumpQueue();
        });
    }
  }

  app.get("/api/queue", (_req, res) => {
    res.json(getQueueStats(state));
  });

  app.post("/api/jobs", (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    const sizePreset = resolveSizePreset(req.body?.sizePreset);
    if (!prompt) {
      return res.status(400).json({
        error: "Prompt is required",
        ...getQueueStats(state),
      });
    }
    if (!sizePreset) {
      return res.status(400).json({
        error: "sizePreset must be one of square, portrait, story, landscape, or widescreen",
        ...getQueueStats(state),
      });
    }

    const rateLimit = applyRateLimit(state, req, resolvedConfig, now);
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded for this IP",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        ...getQueueStats(state),
      });
    }

    const job = {
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      prompt,
      sizePreset,
      status: "queued",
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      imageDataUrl: "",
      error: "",
    };

    state.jobs.set(job.id, job);
    state.pendingQueue.push(job.id);
    pumpQueue();

    return res.status(202).json({
      jobId: job.id,
      ...serializeJob(state, job),
    });
  });

  app.get("/api/jobs/:jobId", (req, res) => {
    const job = state.jobs.get(req.params.jobId);
    if (!job || job.sessionId !== req.sessionId) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(serializeJob(state, job));
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.locals.state = state;
  app.locals.config = resolvedConfig;
  app.locals.jobPollIntervalMs = JOB_POLL_INTERVAL_MS;

  return { app, state, config: resolvedConfig };
}

async function startServer(options = {}) {
  const { app, state, config } = createApp(options);

  const server = await new Promise((resolve, reject) => {
    const httpServer = app
      .listen(options.port ?? config.port, options.host ?? config.host)
      .once("listening", () => resolve(httpServer))
      .once("error", reject);
  });

  return {
    app,
    state,
    config,
    server,
    port: server.address().port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SIZE_PRESET,
  JOB_POLL_INTERVAL_MS,
  SIZE_PRESET_TO_API_SIZE,
  createApp,
  createState,
  generateImageViaApi,
  getQueueStats,
  getPendingCount,
  getQueuePosition,
  loadConfig,
  normalizeBaseUrl,
  normalizeHost,
  parseCookies,
  resolveSizePreset,
  startServer,
  validateConfig,
};

if (require.main === module) {
  startServer()
    .then(({ port }) => {
      console.log(`GPT Image Playground listening on http://127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

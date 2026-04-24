const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const {
  DEFAULT_HOST,
  startServer,
  loadConfig,
  generateImageViaApi,
} = require("../server.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "image-playground-server-"));
}

function createClient(baseUrl) {
  let cookie = "";

  return {
    async request(requestPath, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) {
        headers.Cookie = cookie;
      }

      const response = await fetch(`${baseUrl}${requestPath}`, {
        ...options,
        headers,
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        cookie = setCookie.split(";")[0];
      }
      return response;
    },

    async json(requestPath, options = {}) {
      const response = await this.request(requestPath, options);
      return {
        status: response.status,
        body: await response.json(),
      };
    },
  };
}

async function waitFor(check, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function startTestServer(overrides = {}) {
  const config = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    host: "0.0.0.0",
    port: 7654,
    concurrency: 2,
    rateLimitMax: 3,
    rateLimitWindowMinutes: 10,
    requestTimeoutMs: 360000,
    ...(overrides.config || {}),
  };

  const started = await startServer({
    port: 0,
    config,
    generateImage: overrides.generateImage,
    now: overrides.now,
    sessionIdFactory: overrides.sessionIdFactory,
    fetchImpl: overrides.fetchImpl,
  });

  return {
    ...started,
    baseUrl: `http://127.0.0.1:${started.port}`,
  };
}

async function getAvailablePort() {
  const server = net.createServer();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("loadConfig throws when config.json is missing or invalid", () => {
  const missingPath = path.join(makeTempDir(), "config.json");
  assert.throws(() => loadConfig(missingPath), /config\.json not found/i);

  const invalidPath = path.join(makeTempDir(), "config.json");
  fs.writeFileSync(
    invalidPath,
    JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      concurrency: 2,
      rateLimitMax: 3,
    })
  );

  assert.throws(
    () => loadConfig(invalidPath),
    /rateLimitWindowMinutes/i
  );
});

test("loadConfig applies optional runtime defaults when config omits them", () => {
  const configPath = path.join(makeTempDir(), "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      concurrency: 2,
      rateLimitMax: 3,
      rateLimitWindowMinutes: 10,
    })
  );

  const loaded = loadConfig(configPath);

  assert.equal(loaded.host, DEFAULT_HOST);
  assert.equal(loaded.port, 7654);
  assert.equal(loaded.requestTimeoutMs, 360000);
});

test("startServer listens on config.host and config.port when no explicit override is passed", async () => {
  const port = await getAvailablePort();
  const started = await startServer({
    config: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      host: "127.0.0.1",
      port,
      concurrency: 1,
      rateLimitMax: 3,
      rateLimitWindowMinutes: 10,
    },
    generateImage: async () => new Promise(() => {}),
  });

  try {
    assert.equal(started.server.address().address, "127.0.0.1");
    assert.equal(started.port, port);
  } finally {
    await started.close();
  }
});

test("same ip is rate-limited on the fourth request within the window", async () => {
  const deferreds = [];
  const started = await startTestServer({
    generateImage: async () => {
      const deferred = createDeferred();
      deferreds.push(deferred);
      return deferred.promise;
    },
  });

  try {
    const client = createClient(started.baseUrl);

    const first = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "first image" }),
    });
    const second = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "second image" }),
    });
    const third = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "third image" }),
    });
    const fourth = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "fourth image" }),
    });

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 202);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.queueCount, 3);
    assert.equal(fourth.body.queuedCount, 1);
    assert.equal(fourth.body.runningCount, 2);
    assert.match(fourth.body.error, /rate limit/i);
  } finally {
    await started.close();
  }
});

test("third job waits in queue and queue stats include running jobs", async () => {
  const deferreds = [];
  const started = await startTestServer({
    config: { concurrency: 2 },
    generateImage: async () => {
      const deferred = createDeferred();
      deferreds.push(deferred);
      return deferred.promise;
    },
  });

  try {
    const client = createClient(started.baseUrl);
    const first = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "alpha" }),
    });
    const second = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "beta" }),
    });
    const third = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "gamma" }),
    });

    assert.equal(first.body.status, "running");
    assert.equal(second.body.status, "running");
    assert.equal(third.body.status, "queued");
    assert.equal(third.body.queuePosition, 1);
    assert.equal(third.body.queueCount, 3);
    assert.equal(third.body.queuedCount, 1);
    assert.equal(third.body.runningCount, 2);

    const queue = await client.json("/api/queue");
    assert.deepEqual(queue.body, {
      queueCount: 3,
      queuedCount: 1,
      runningCount: 2,
    });

    deferreds[0].resolve("data:image/png;base64,AAA");

    await waitFor(async () => {
      const job = await client.json(`/api/jobs/${third.body.jobId}`);
      if (job.body.status === "running") {
        return job;
      }
      return null;
    });

    const queueAfterStart = await client.json("/api/queue");
    assert.deepEqual(queueAfterStart.body, {
      queueCount: 2,
      queuedCount: 0,
      runningCount: 2,
    });
  } finally {
    await started.close();
  }
});

test("jobs are only visible to the session that created them", async () => {
  const started = await startTestServer({
    generateImage: async () => new Promise(() => {}),
  });

  try {
    const author = createClient(started.baseUrl);
    const stranger = createClient(started.baseUrl);

    const created = await author.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "private prompt" }),
    });

    const ownJob = await author.json(`/api/jobs/${created.body.jobId}`);
    const foreignJob = await stranger.request(`/api/jobs/${created.body.jobId}`);

    assert.equal(ownJob.status, 200);
    assert.equal(foreignJob.status, 404);
  } finally {
    await started.close();
  }
});

test("failed jobs release the worker slot for the next queued job", async () => {
  const first = createDeferred();
  const second = createDeferred();
  let calls = 0;

  const started = await startTestServer({
    config: { concurrency: 1 },
    generateImage: async () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });

  try {
    const client = createClient(started.baseUrl);
    const jobOne = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "first" }),
    });
    const jobTwo = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "second" }),
    });

    assert.equal(jobOne.body.status, "running");
    assert.equal(jobTwo.body.status, "queued");

    first.reject(new Error("upstream failed"));

    await waitFor(async () => {
      const failed = await client.json(`/api/jobs/${jobOne.body.jobId}`);
      const moved = await client.json(`/api/jobs/${jobTwo.body.jobId}`);
      if (failed.body.status === "failed" && moved.body.status === "running") {
        assert.equal(failed.body.queueCount, 1);
        assert.equal(moved.body.queueCount, 1);
        return true;
      }
      return false;
    });

    const queue = await client.json("/api/queue");
    assert.deepEqual(queue.body, {
      queueCount: 1,
      queuedCount: 0,
      runningCount: 1,
    });
  } finally {
    await started.close();
  }
});

test("successful jobs expose imageDataUrl to the owning session", async () => {
  const started = await startTestServer({
    generateImage: async () => "data:image/png;base64,QUJD",
  });

  try {
    const client = createClient(started.baseUrl);
    const created = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "sunlit paper" }),
    });

    const finished = await waitFor(async () => {
      const job = await client.json(`/api/jobs/${created.body.jobId}`);
      if (job.body.status === "succeeded") {
        return job;
      }
      return null;
    });

    assert.equal(finished.body.imageDataUrl, "data:image/png;base64,QUJD");
    assert.equal(finished.body.queuePosition, 0);
    assert.equal(finished.body.queueCount, 0);
    assert.equal(finished.body.queuedCount, 0);
    assert.equal(finished.body.runningCount, 0);
  } finally {
    await started.close();
  }
});

test("generateImageViaApi maps every size preset to the expected upstream size", async () => {
  const seenSizes = [];
  const presets = [
    ["square", "1024x1024"],
    ["portrait", "1024x1536"],
    ["story", "1024x1536"],
    ["landscape", "1536x1024"],
    ["widescreen", "1536x1024"],
  ];

  for (const [sizePreset, expectedSize] of presets) {
    const result = await generateImageViaApi({
      config: {
        baseUrl: "https://example.test/v1/",
        apiKey: "sk-demo",
      },
      prompt: "paper sculpture crane",
      sizePreset,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(url, "https://example.test/v1/images/generations");
        assert.equal(body.model, "gpt-image-2");
        assert.equal(body.size, expectedSize);
        seenSizes.push(body.size);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ b64_json: "QUJD" }],
          }),
        };
      },
    });

    assert.equal(result, "data:image/png;base64,QUJD");
  }

  assert.deepEqual(seenSizes, presets.map(([, size]) => size));
});

test("createApp forwards configured request timeout to the image generator", async () => {
  const calls = [];
  const started = await startTestServer({
    config: { requestTimeoutMs: 360000 },
    generateImage: async (options) => {
      calls.push(options.timeoutMs);
      return "data:image/png;base64,AAAA";
    },
  });

  try {
    const client = createClient(started.baseUrl);
    const created = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "square paper sculpture",
        sizePreset: "square",
      }),
    });

    assert.equal(created.status, 202);

    await waitFor(() => (calls.length === 1 ? true : null));
    assert.deepEqual(calls, [360000]);
  } finally {
    await started.close();
  }
});

test("job creation forwards sizePreset to the image generator", async () => {
  const calls = [];
  const started = await startTestServer({
    generateImage: async (options) => {
      calls.push(options.sizePreset);
      return "data:image/png;base64,AAAA";
    },
  });

  try {
    const client = createClient(started.baseUrl);
    const created = await client.json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "vertical poster",
        sizePreset: "story",
      }),
    });

    assert.equal(created.status, 202);

    await waitFor(() => (calls.length === 1 ? true : null));
    assert.deepEqual(calls, ["story"]);
  } finally {
    await started.close();
  }
});

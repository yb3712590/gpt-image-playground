const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildConfigFromCodex,
  writeConfigFile,
} = require("../scripts/bootstrap-config.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "image-playground-bootstrap-"));
}

test("buildConfigFromCodex reads api key and active provider base url", () => {
  const codexHome = makeTempDir();
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(
      {
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-test-123",
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model_provider = "demo"

[model_providers.demo]
base_url = "https://example.test/v1"
`.trimStart()
  );

  const result = buildConfigFromCodex({ codexHome });

  assert.deepEqual(result, {
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test-123",
    host: "0.0.0.0",
    port: 7654,
    concurrency: 2,
    rateLimitMax: 3,
    rateLimitWindowMinutes: 10,
    requestTimeoutMs: 360000,
  });
});

test("writeConfigFile writes config.json to the target directory", () => {
  const targetDir = makeTempDir();
  const config = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-demo",
    host: "0.0.0.0",
    port: 7654,
    concurrency: 2,
    rateLimitMax: 3,
    rateLimitWindowMinutes: 10,
    requestTimeoutMs: 360000,
  };

  const outputPath = writeConfigFile({ targetDir, config, force: true });
  const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));

  assert.equal(outputPath, path.join(targetDir, "config.json"));
  assert.deepEqual(written, config);
});

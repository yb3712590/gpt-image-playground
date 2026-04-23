const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const toml = require("toml");

function resolveCodexHome(explicitCodexHome) {
  return explicitCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function pickBaseUrl(configToml) {
  const providerName = configToml.model_provider;
  const providers = configToml.model_providers || {};

  if (providerName && providers[providerName]?.base_url) {
    return providers[providerName].base_url;
  }

  for (const provider of Object.values(providers)) {
    if (provider && provider.base_url) {
      return provider.base_url;
    }
  }

  throw new Error("No base_url found in .codex/config.toml");
}

function buildConfigFromCodex({ codexHome } = {}) {
  const resolvedCodexHome = resolveCodexHome(codexHome);
  const authPath = path.join(resolvedCodexHome, "auth.json");
  const configPath = path.join(resolvedCodexHome, "config.toml");

  if (!fs.existsSync(authPath)) {
    throw new Error(`auth.json not found at ${authPath}`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }

  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const apiKey = String(auth.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in auth.json");
  }

  const parsedToml = toml.parse(fs.readFileSync(configPath, "utf8"));

  return {
    baseUrl: pickBaseUrl(parsedToml),
    apiKey,
    host: "0.0.0.0",
    port: 7654,
    concurrency: 2,
    rateLimitMax: 3,
    rateLimitWindowMinutes: 10,
  };
}

function writeConfigFile({ targetDir = process.cwd(), config, force = false }) {
  const outputPath = path.join(targetDir, "config.json");
  if (fs.existsSync(outputPath) && !force) {
    throw new Error(`config.json already exists at ${outputPath}. Use --force to overwrite.`);
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return outputPath;
}

module.exports = {
  buildConfigFromCodex,
  pickBaseUrl,
  resolveCodexHome,
  writeConfigFile,
};

if (require.main === module) {
  try {
    const outputPath = writeConfigFile({
      config: buildConfigFromCodex(),
      force: process.argv.includes("--force"),
    });
    console.log(`Wrote ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

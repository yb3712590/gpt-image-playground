const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8"
);

test("layout uses a top-level preview workspace instead of the oversized hero copy", () => {
  assert.match(html, /class="workspace"/);
  assert.match(html, /class="[^"]*\bpreview-panel\b[^"]*"/);
  assert.match(html, /class="[^"]*\bcontrol-panel\b[^"]*"/);
  assert.match(
    html,
    /\.workspace\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(320px,\s*1fr\);/
  );
  assert.doesNotMatch(html, /Prompt\. Queue\. Render\./);
  assert.doesNotMatch(html, />Latest frame</);
});

test("dark workstation exposes only unique frontend size presets", () => {
  assert.match(html, /#020617/);
  assert.match(html, /Fira\+Code/);
  assert.match(html, /data-state="idle"/);
  assert.match(html, /id="character-count"/);
  assert.match(html, /class="[^"]*\bprompt-example\b[^"]*"/);

  const sizeValues = Array.from(
    html.matchAll(/name="size-preset" value="([^"]+)"/g),
    (match) => match[1]
  );
  assert.deepEqual(sizeValues, ["square", "portrait", "landscape"]);
  assert.doesNotMatch(html, /value="story"/);
  assert.doesNotMatch(html, /value="widescreen"/);
});

test("hidden media and modules stay visually hidden despite component display styles", () => {
  assert.match(html, /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important;/);
  assert.match(html, /<img id="result-image"[^>]*hidden/);
});

test("preview image fits inside the render frame without forced cropping", () => {
  const frameImageRule = html.match(/\.frame img\s*\{[\s\S]*?\n\s*\}/)?.[0] || "";
  assert.match(frameImageRule, /position:\s*absolute;/);
  assert.match(frameImageRule, /inset:\s*22px;/);
  assert.match(frameImageRule, /width:\s*calc\(100% - 44px\);/);
  assert.match(frameImageRule, /height:\s*calc\(100% - 44px\);/);
  assert.match(frameImageRule, /object-fit:\s*contain;/);
  assert.match(frameImageRule, /object-position:\s*center center;/);
  assert.doesNotMatch(frameImageRule, /transform:/);
  assert.doesNotMatch(html, /@keyframes imageReveal[\s\S]*transform:/);
  assert.match(html, /\.workspace\[data-state="succeeded"\] \.frame::after\s*\{[\s\S]*opacity:\s*0;/);
});

test("dark workstation styles textarea scrollbar and status dot consistently", () => {
  assert.match(html, /textarea\s*\{[\s\S]*scrollbar-color:\s*var\(--accent\) rgba\(2, 6, 23, 0\.72\);/);
  assert.match(html, /textarea::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*linear-gradient/);
  assert.match(html, /\.status-dot\s*\{/);
  assert.match(html, /\.workspace\[data-state="queued"\] \.status-dot/);
  assert.doesNotMatch(html, /\.状态-dot/);
});

test("page copy is localized to Chinese with two polished starter prompts", () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, />构图\. 排队\. 生成\.</);
  assert.match(html, /真实摄影风格 ·/);
  assert.match(html, /二次元插画风格 ·/);
  assert.match(html, /电影级真实摄影/);
  assert.match(html, /精致二次元插画/);
  assert.match(html, /id="status-text"/);

  const starterCount = Array.from(html.matchAll(/class="prompt-example"/g)).length;
  assert.equal(starterCount, 2);
  assert.doesNotMatch(html, /Compose\. Queue\. Render\./);
  assert.doesNotMatch(html, /Product lab/);
  assert.doesNotMatch(html, /Editorial/);
});

test("desktop layout scales workspace height with clamp-based viewport sizing", () => {
  assert.match(html, /--workspace-min-height:\s*\d+px;/);
  assert.match(html, /--workspace-max-height:\s*\d+px;/);
  assert.match(
    html,
    /\.workspace\s*\{[\s\S]*height:\s*clamp\(var\(--workspace-min-height\),\s*calc\(100dvh - 112px\),\s*var\(--workspace-max-height\)\);/
  );
  assert.match(
    html,
    /@media \(max-width:\s*880px\)\s*\{[\s\S]*\.workspace\s*\{[\s\S]*height:\s*auto;/
  );
});

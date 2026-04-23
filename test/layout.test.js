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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pub = new URL("../public/", import.meta.url);
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test("manifest is installable-shaped and every icon exists at its declared size", () => {
  const m = JSON.parse(readFileSync(new URL("manifest.webmanifest", pub), "utf8"));
  assert.equal(m.display, "standalone");
  assert.ok(m.name && m.short_name && m.start_url && m.theme_color && m.background_color);
  const purposes = new Set(m.icons.map((i) => i.purpose));
  assert.ok(purposes.has("maskable"));
  for (const icon of m.icons) {
    const buf = readFileSync(new URL(icon.src.slice(1), pub));
    if (icon.type === "image/png") {
      const [w, h] = pngSize(buf);
      assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
  }
  for (const size of ["192x192", "512x512"]) assert.ok(m.icons.some((i) => i.sizes === size && i.purpose === "any"), size);
});

test("index.html links the manifest and the 180 px apple-touch-icon", () => {
  const html = readFileSync(new URL("index.html", pub), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  const m = html.match(/<link rel="apple-touch-icon" href="\/([^"]+)">/);
  assert.deepEqual(pngSize(readFileSync(new URL(m[1], pub))), [180, 180]);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
});

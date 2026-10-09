// Renders the PNG app icons from the SVG sources: node icons/render.mjs icons public (needs playwright).
import { chromium } from "playwright";
import fs from "fs";
const [dir, out] = process.argv.slice(2);
const jobs = [["icon-square.svg", "icon-192.png", 192], ["icon-square.svg", "icon-512.png", 512], ["icon-maskable.svg", "icon-maskable-512.png", 512], ["icon-square.svg", "apple-touch-icon.png", 180]];
const b = await chromium.launch();
const p = await b.newPage();
for (const [src, dst, size] of jobs) {
  const svg = fs.readFileSync(`${dir}/${src}`, "utf8");
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block">`);
  await p.screenshot({ path: `${out}/${dst}`, omitBackground: true });
}
await b.close();

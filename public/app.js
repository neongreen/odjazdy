import {
  departures, formatDistance, formatWait, indexStops, nearestGroups, normalizeLine, polesForLine, searchStops,
} from "./core.js";

const $ = (id) => document.getElementById(id);
const els = {
  where: $("where"), line: $("line"), clear: $("clear"), ask: $("ask"), place: $("place"),
  stopq: $("stopq"), stopResults: $("stopResults"), results: $("results"), feedTime: $("feedTime"),
};

const state = {
  stops: null, lines: null, // Map line -> { line, type, color, name }
  loc: null, // { lat, lon, source: "gps" | "stop", label }
  geoError: null,
  line: "",
  lineData: new Map(),
  vehicles: { line: "", list: [], time: null, error: null },
};

const nowMin = () => Date.now() / 60000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Tram red, bus ink, night blue, metro/rail in their own tones; GTFS colours are too uniform for buses.
function lineTone(line) {
  const info = state.lines?.get(line);
  if (!info) return "bus";
  if (info.type === 0) return "tram";
  if (info.type === 1) return "metro";
  if (info.type === 2) return "rail";
  if (/^N/.test(line)) return "night";
  if (/^[EZL]/.test(line)) return "special";
  return "bus";
}
const chip = (line, tag = "button") =>
  `<${tag} class="chip tone-${lineTone(line)}" ${tag === "button" ? `type="button" data-line="${esc(line)}"` : ""}>${esc(line)}</${tag}>`;

async function loadIndex() {
  const res = await fetch("/data/index.json");
  if (!res.ok) throw new Error("index " + res.status);
  const idx = await res.json();
  state.stops = indexStops(idx.stops);
  state.lines = new Map(idx.lines.map(([line, type, color, name]) => [line, { line, type, color, name }]));
  state.validUntil = idx.validUntil;
}

// Resolves to the line JSON, or null after a failed load. A failure is not cached:
// the next call (retry button or the periodic refresh) fetches again.
async function loadLine(line) {
  if (state.lineData.get(line)) return state.lineData.get(line);
  const safe = line.replace(/[^A-Za-z0-9_-]/g, "_");
  let data = null;
  try {
    const res = await fetch(`/data/lines/${safe}.json`);
    if (res.ok) data = await res.json();
  } catch {
    data = null;
  }
  state.lineData.set(line, data);
  return data;
}

function showLine(line) {
  loadLine(line).then(() => { render(); refreshVehicles(); });
}

async function refreshVehicles() {
  const line = state.line;
  if (!line || !state.lines?.has(line)) return;
  try {
    const res = await fetch(`/api/vehicles?line=${encodeURIComponent(line)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    if (line !== state.line) return;
    state.vehicles = {
      line,
      time: body.time,
      error: null,
      list: body.vehicles.map((v) => ({ tripId: v.tripId, lat: v.lat, lon: v.lon, tsMin: Date.parse(v.ts) / 60000 }))
        // Positions older than 3 minutes say nothing about the current delay.
        .filter((v) => nowMin() - v.tsMin < 3),
    };
  } catch (e) {
    state.vehicles = { line, list: [], time: null, error: String(e.message || e) };
  }
  render();
}

function locate() {
  if (!("geolocation" in navigator)) {
    state.geoError = "unsupported";
    return render();
  }
  els.where.textContent = "Определяю, где вы…";
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (state.loc?.source === "stop") return;
      // Ignore jitter under 40 m to keep the list from jumping.
      if (state.loc && Math.hypot(lat - state.loc.lat, (lon - state.loc.lon) * 0.61) * 111000 < 40) return;
      state.loc = { lat, lon, source: "gps" };
      state.geoError = null;
      render();
    },
    (err) => {
      state.geoError = err.code === 1 ? "denied" : "unavailable";
      if (!state.loc) els.place.hidden = false;
      render();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
  );
}

function setLine(raw, { push = true } = {}) {
  const line = normalizeLine(raw);
  state.line = line;
  els.line.value = line;
  els.clear.hidden = !line;
  if (push) {
    const url = new URL(location.href);
    if (line) url.searchParams.set("l", line); else url.searchParams.delete("l");
    history.replaceState(null, "", url);
  }
  state.vehicles = { line, list: [], time: null, error: null };
  render();
  if (line && state.lines?.has(line)) showLine(line);
}

function renderWhere() {
  const { loc, geoError } = state;
  if (loc?.source === "stop") els.where.innerHTML = `Остановка <b>${esc(loc.label)}</b> <span class="muted">· изменить</span>`;
  else if (loc && state.stops) {
    const g = nearestGroups(state.stops, loc.lat, loc.lon, { limit: 1, maxDist: 3000 })[0];
    els.where.innerHTML = g ? `Рядом <b>${esc(g.name)}</b> <span class="muted">· ${formatDistance(g.dist)}</span>` : "Вы далеко от Варшавы";
  } else if (geoError) els.where.textContent = "Где вы? Выберите остановку";
  else els.where.textContent = "Определяю, где вы…";
}

function renderNearby() {
  const { loc } = state;
  const groups = nearestGroups(state.stops, loc.lat, loc.lon, { limit: 6, maxDist: 1500 });
  if (!groups.length) {
    return `<p class="empty">В радиусе 1,5 км нет остановок. Найдите остановку по названию.</p>`;
  }
  return `<h2 class="section-title">Остановки рядом</h2>
  <ul class="nearby">${groups.map((g) => `
    <li class="stop">
      <div class="stop-head"><span class="stop-name">${esc(g.name)}</span><span class="dist">${formatDistance(g.dist)}</span></div>
      <div class="chips">${g.lines.sort(lineCompare).map((l) => chip(l)).join("")}</div>
    </li>`).join("")}
  </ul>`;
}

function lineCompare(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b, "pl", { numeric: true });
}

function renderLine() {
  const { line, loc } = state;
  const info = state.lines.get(line);
  if (!info) {
    return `<p class="empty">Линии <b>${esc(line)}</b> нет в расписании на ближайшие сутки.</p>`;
  }
  const head = `<div class="line-head">${chip(line, "span")}<span class="line-name">${esc(info.name)}</span></div>`;
  const data = state.lineData.get(line);
  if (data === undefined) return head + `<p class="empty">Загружаю расписание…</p>`;
  if (data === null) return head + `<p class="empty">Не удалось загрузить расписание линии. <button type="button" class="retry" data-retry>Повторить</button></p>`;

  const now = nowMin();
  // Some poles list the line only for depot or night variants; prefer poles with departures soon.
  const candidates = polesForLine(state.stops, line, loc.lat, loc.lon, { max: 12 });
  const deps = departures(data, state.stops, candidates.map((p) => p.id), state.vehicles.line === line ? state.vehicles.list : [], now);
  const active = candidates.filter((p) => deps.get(p.id).length);
  // A farther pole with the same directions as a nearer one adds nothing.
  const seenDirs = new Set();
  const poles = (active.length ? active : candidates).filter((p) => {
    const dirs = [...new Set(deps.get(p.id).map((d) => d.headsign))].sort().join("|");
    if (dirs && seenDirs.has(dirs)) return false;
    seenDirs.add(dirs);
    return true;
  }).slice(0, 4);
  const far = poles.length && poles[0].dist > 900;

  const blocks = poles.map((p) => {
    const list = deps.get(p.id) || [];
    const heads = [...new Set(list.map((d) => d.headsign))];
    const oneHead = heads.length === 1;
    const rows = list.map((d, i) => `
      <li class="dep ${i === 0 ? "first" : ""}">
        <span class="wait">${formatWait(d.est, now)}</span>
        <span class="note">${oneHead ? "" : `<span class="to">→ ${esc(d.headsign)}</span>`}${depNote(d)}</span>
      </li>`).join("");
    return `<article class="pole">
      <div class="pole-head">
        <span class="stop-name">${esc(p.name)}</span><span class="pole-code">${esc(p.code)}</span>
        <span class="dist">${formatDistance(p.dist)}</span>
      </div>
      ${oneHead ? `<div class="dir">→ ${esc(heads[0])}</div>` : ""}
      ${list.length ? `<ol class="deps">${rows}</ol>` : `<p class="none">В ближайшие 2 часа отправлений нет.</p>`}
    </article>`;
  }).join("");

  const live = state.vehicles.line === line && state.vehicles.error
    ? `<p class="live-off">Положение машин сейчас недоступно, показано расписание.</p>` : "";
  return head + (far ? `<p class="hint">Ближайшая остановка этой линии — ${formatDistance(poles[0].dist)} от вас.</p>` : "") + live + blocks;
}

function depNote(d) {
  if (d.approx) return "интервал, примерно";
  const at = new Date(d.sched * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });
  if (!d.live) return `по расписанию ${at}`;
  if (d.waiting) return `<i class="dot"></i>на конечной · ${d.delay >= 1 ? `опаздывает на ${d.delay} мин` : `по расписанию ${at}`}`;
  if (d.delay >= 1) return `<i class="dot"></i>в пути · опаздывает на ${d.delay} мин`;
  if (d.delay <= -1) return `<i class="dot"></i>в пути · раньше на ${-d.delay} мин`;
  return `<i class="dot"></i>в пути · по расписанию ${at}`;
}

function render() {
  renderWhere();
  els.feedTime.textContent = state.vehicles.time
    ? `, данные на ${new Date(state.vehicles.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Warsaw" })}`
    : "";
  if (!state.stops) {
    els.results.innerHTML = state.indexError
      ? `<p class="empty">Не удалось загрузить данные. Проверьте соединение. <button type="button" class="retry" data-retry>Повторить</button></p>`
      : `<p class="empty">Загружаю остановки…</p>`;
    return;
  }
  if (state.validUntil && nowMin() > state.validUntil) {
    els.results.innerHTML = `<p class="empty">Расписание устарело. Обновите страницу позже.</p>`;
    return;
  }
  if (!state.loc) {
    els.results.innerHTML = state.geoError
      ? `<p class="empty">${state.geoError === "denied" ? "Доступ к геолокации запрещён." : "Не удалось определить местоположение."} Найдите остановку по названию.</p>`
      : `<p class="empty">Ищу ближайшие остановки…</p>`;
    return;
  }
  els.results.innerHTML = state.line ? renderLine() : renderNearby();
}

// Events
els.ask.addEventListener("submit", (e) => { e.preventDefault(); setLine(els.line.value); els.line.blur(); });
els.line.addEventListener("input", () => {
  const v = normalizeLine(els.line.value);
  els.clear.hidden = !v;
  // Apply as soon as the typed text is a known line; "1" waits for Enter only when longer lines share the prefix.
  if (!v) setLine("");
  else if (state.lines?.has(v) && ![...state.lines.keys()].some((l) => l !== v && l.startsWith(v))) setLine(v);
});
els.clear.addEventListener("click", () => { setLine(""); els.line.focus(); });
els.results.addEventListener("click", (e) => {
  if (e.target.closest("[data-retry]")) {
    if (!state.stops) startup(); else showLine(state.line);
    return;
  }
  const b = e.target.closest("[data-line]");
  if (b) { setLine(b.dataset.line); window.scrollTo({ top: 0, behavior: "smooth" }); }
});
els.where.addEventListener("click", () => {
  els.place.hidden = !els.place.hidden;
  if (!els.place.hidden) els.stopq.focus();
});
els.stopq.addEventListener("input", () => {
  const found = state.stops ? searchStops(state.stops, els.stopq.value) : [];
  const gps = state.loc?.source === "stop" ? `<li><button type="button" class="stop-pick" data-gps>Моё местоположение</button></li>` : "";
  els.stopResults.innerHTML = gps + found.map((g, i) =>
    `<li><button type="button" class="stop-pick" data-i="${i}">${esc(g.name)}</button></li>`).join("");
  els.stopResults._found = found;
});
els.stopResults.addEventListener("click", (e) => {
  const b = e.target.closest(".stop-pick");
  if (!b) return;
  if (b.dataset.gps !== undefined) {
    state.loc = null;
    locate();
  } else {
    const g = els.stopResults._found[Number(b.dataset.i)];
    state.loc = { lat: g.lat, lon: g.lon, source: "stop", label: g.name };
  }
  els.place.hidden = true;
  els.stopq.value = "";
  els.stopResults.innerHTML = "";
  render();
});

// Start
const initial = new URL(location.href).searchParams.get("l");
locate();
function startup() {
  state.indexError = false;
  render();
  loadIndex().then(() => {
    if (initial && !state.line) setLine(initial, { push: false }); else if (state.line) setLine(state.line); else render();
  }).catch(() => {
    state.indexError = true;
    render();
  });
}
startup();
setInterval(() => { if (state.stops) render(); }, 15000);
setInterval(() => {
  if (document.hidden) return;
  if (state.line && state.lines?.has(state.line) && state.lineData.get(state.line) === null) showLine(state.line);
  else refreshVehicles();
}, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshVehicles(); });

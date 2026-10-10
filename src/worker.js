// Serves the static site and a small live-vehicles endpoint.
//
// GET /api/vehicles?line=175 -> { time, vehicles: [{ tripId, lat, lon, ts, side }] }
// Source: mkuran.pl republishes Warsaw City Hall vehicle positions (api.um.warszawa.pl)
// keyed by GTFS trip_id. The feed is ~0.5 MB, so the Worker caches it for a few seconds
// and returns only the requested line.

const FEED = "https://mkuran.pl/gtfs/warsaw/vehicles.json";
const FEED_TTL = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/vehicles") return vehicles(url, ctx);
    if (url.pathname === "/api/transcribe") return transcribe(request, url, env);
    return env.ASSETS.fetch(request);
  },
};

export function lineOfTrip(tripId) {
  // "2026-10-09:175:PtS:412:1513" -> "175"
  return String(tripId || "").split(":")[1] || null;
}

export function filterFeed(feed, line) {
  const out = [];
  for (const p of feed.positions || []) {
    if (lineOfTrip(p.trip_id) !== line) continue;
    out.push({ tripId: p.trip_id, lat: p.lat, lon: p.lon, ts: p.timestamp, side: p.side_number || null });
  }
  return { time: feed.time || null, vehicles: out };
}

async function loadFeed(ctx) {
  const cache = caches.default;
  const key = new Request(FEED);
  let res = await cache.match(key);
  if (!res) {
    const upstream = await fetch(FEED, { headers: { "user-agent": "odjazdy (+https://github.com/neongreen/odjazdy)" } });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    res = new Response(upstream.body, { headers: { "content-type": "application/json", "cache-control": `max-age=${FEED_TTL}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res.json();
}

async function vehicles(url, ctx) {
  const line = (url.searchParams.get("line") || "").trim().toUpperCase();
  if (!line || line.length > 6) return json({ error: "line required" }, 400);
  try {
    return json(filterFeed(await loadFeed(ctx), line), 200, FEED_TTL);
  } catch (e) {
    return json({ error: "live feed unavailable", detail: String(e.message || e) }, 502);
  }
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}

// POST /api/transcribe?lat=..&lon=.. with the recorded audio as the body -> { text }
// Runs Whisper on Workers AI. The names of stops near the user go in as the initial prompt,
// which steers Whisper to the Polish spelling of names it would otherwise mishear
// ("Арховецка" -> "Orchowiecka"); the page then matches the text against the full stop list.

const MAX_AUDIO_BYTES = 1_000_000; // ~10 s of AAC/Opus from a phone microphone
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
let stopIndex = null;

async function nearbyStopNames(env, origin, lat, lon, count = 40) {
  if (!stopIndex) {
    const res = await env.ASSETS.fetch(new Request(origin + "/data/index.json"));
    if (!res.ok) return [];
    stopIndex = (await res.json()).stops;
  }
  const best = new Map();
  for (const [, name, , slat, slon] of stopIndex) {
    const d = (slat - lat) ** 2 + ((slon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (!best.has(name) || d < best.get(name)) best.set(name, d);
  }
  return [...best].sort((a, b) => a[1] - b[1]).slice(0, count).map(([name]) => name);
}

export function whisperPrompt(names) {
  return names.length ? `Остановка в Варшаве. Например: ${names.join(", ")}.` : "Остановка в Варшаве.";
}

async function transcribe(request, url, env) {
  if (request.method !== "POST") return json({ error: "POST audio" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
  const audio = new Uint8Array(await request.arrayBuffer());
  if (!audio.length) return json({ error: "empty audio" }, 400);
  if (audio.length > MAX_AUDIO_BYTES) return json({ error: "audio too long" }, 413);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const names = Number.isFinite(lat) && Number.isFinite(lon) && url.searchParams.has("lat")
    ? await nearbyStopNames(env, url.origin, lat, lon) : [];
  let b64 = "";
  for (let i = 0; i < audio.length; i += 0x8000) b64 += String.fromCharCode(...audio.subarray(i, i + 0x8000));
  try {
    const out = await env.AI.run(WHISPER, { audio: btoa(b64), language: "ru", initial_prompt: whisperPrompt(names), vad_filter: true });
    return json({ text: String(out.text || "").trim() });
  } catch (e) {
    return json({ error: "transcription failed", detail: String(e.message || e) }, 502);
  }
}

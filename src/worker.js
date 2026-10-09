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

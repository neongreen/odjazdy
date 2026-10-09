// Pure logic shared by the page and the tests. No DOM access here.

// Trip tuple layout written by scripts/build_data.py.
export const T_ID = 0, T_HEADSIGN = 1, T_FIRST = 2, T_STOPS = 3, T_OFFSETS = 4, T_NODEP = 5, T_APPROX = 6;

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Local planar projection in metres around a reference latitude; good enough within a city.
function toXY(lat, lon, refLat) {
  return [rad(lon) * R * Math.cos(rad(refLat)), rad(lat) * R];
}

/** Distance from point p to segment a-b and the fraction along a-b of the closest point. */
export function projectOnSegment(p, a, b) {
  const [px, py] = toXY(p[0], p[1], p[0]);
  const [ax, ay] = toXY(a[0], a[1], p[0]);
  const [bx, by] = toXY(b[0], b[1], p[0]);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let f = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  f = Math.max(0, Math.min(1, f));
  const cx = ax + f * dx, cy = ay + f * dy;
  return { dist: Math.hypot(px - cx, py - cy), f };
}

/** Normalises a typed line: trims and uppercases ("n01 " -> "N01"). */
export function normalizeLine(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "");
}

/** Index from stop id to stop record: { id, name, code, lat, lon, lines }. */
export function indexStops(rawStops) {
  const byId = new Map();
  for (const [id, name, code, lat, lon, lines] of rawStops) byId.set(id, { id, name, code, lat, lon, lines });
  return byId;
}

/**
 * Groups poles by stop name and sorts the groups by distance of their closest pole.
 * Returns [{ name, dist, poles: [{...stop, dist}], lines: [] }].
 */
export function nearestGroups(stopsById, lat, lon, { limit = 6, maxDist = 1500 } = {}) {
  const groups = new Map();
  for (const s of stopsById.values()) {
    const dist = distanceM(lat, lon, s.lat, s.lon);
    if (dist > maxDist) continue;
    let g = groups.get(s.name);
    if (!g) groups.set(s.name, (g = { name: s.name, dist, poles: [], lines: new Set() }));
    g.dist = Math.min(g.dist, dist);
    g.poles.push({ ...s, dist });
    for (const l of s.lines) g.lines.add(l);
  }
  return [...groups.values()]
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((g) => ({ ...g, poles: g.poles.sort((a, b) => a.dist - b.dist), lines: [...g.lines] }));
}

/**
 * Poles served by a line, nearest first. Takes every pole within `radius`, and at
 * least `min` poles regardless of distance so a far-away line still answers.
 */
export function polesForLine(stopsById, line, lat, lon, { radius = 900, min = 2, max = 4 } = {}) {
  const poles = [];
  for (const s of stopsById.values()) {
    if (s.lines.includes(line)) poles.push({ ...s, dist: distanceM(lat, lon, s.lat, s.lon) });
  }
  poles.sort((a, b) => a.dist - b.dist);
  const near = poles.filter((p) => p.dist <= radius);
  return (near.length >= min ? near : poles.slice(0, min)).slice(0, max);
}

/** Trip key without the leading date, which the realtime feed and the timetable can disagree on. */
export function tripKey(tripId) {
  if (!tripId) return null;
  const i = tripId.indexOf(":");
  return i < 0 ? tripId : tripId.slice(i + 1);
}

/**
 * Estimates how late a live vehicle runs on its trip.
 * coords[i] = [lat, lon] of the i-th stop of the trip; vehicle = { lat, lon, tsMin }.
 * Returns { delay (minutes, positive = late), passed (index of the last stop already left),
 * waiting (still at the first stop) } or null.
 */
export function estimateProgress(trip, coords, vehicle, { maxOffRoute = 300 } = {}) {
  const first = trip[T_FIRST];
  const offs = trip[T_OFFSETS];
  const p = [vehicle.lat, vehicle.lon];
  let best = null;
  for (let j = 0; j + 1 < coords.length; j++) {
    if (!coords[j] || !coords[j + 1]) continue;
    const { dist, f } = projectOnSegment(p, coords[j], coords[j + 1]);
    if (dist > maxOffRoute) continue;
    const sched = first + offs[j] + f * (offs[j + 1] - offs[j]);
    const delay = vehicle.tsMin - sched;
    // A route can pass the same place twice; pick the candidate closest in time.
    if (!best || Math.abs(delay) < Math.abs(best.delay)) best = { delay, j, f, dist };
  }
  if (!best) return null;
  // Before the scheduled start the vehicle waits at the terminus: it cannot be early.
  if (vehicle.tsMin < first || (best.j === 0 && best.f === 0)) return { delay: Math.max(0, best.delay), passed: -1, waiting: true };
  // Buses and trams rarely run more than a few minutes early; a larger negative delay
  // means the position matched the wrong place (loops, layovers), so trust the timetable.
  if (best.delay < -3 || best.delay > 90) return null;
  // Within ~40 m of stop j the vehicle is still standing there, so only stops before j are passed.
  const segLen = distanceM(coords[best.j][0], coords[best.j][1], coords[best.j + 1][0], coords[best.j + 1][1]);
  const passed = segLen * best.f < 40 ? best.j - 1 : best.j;
  return { delay: best.delay, passed, waiting: false };
}

/**
 * Next departures of one line at the given poles.
 * lineData: the per-line JSON; vehicles: [{ tripId, lat, lon, tsMin }]; nowMin: Unix minutes.
 * Returns Map(poleId -> [{ headsign, sched, est, live, waiting, delay, approx }]) sorted by est.
 */
export function departures(lineData, stopsById, poleIds, vehicles, nowMin, { horizon = 120, perPole = 4 } = {}) {
  const wanted = new Set(poleIds);
  const result = new Map(poleIds.map((id) => [id, []]));

  // Realtime matches by trip key; several runs can share a key on consecutive days,
  // so the one whose time span is closest to the position time wins.
  const byKey = new Map();
  lineData.trips.forEach((t, i) => {
    const k = tripKey(t[T_ID]);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const progress = new Map();
  for (const v of vehicles || []) {
    const cands = byKey.get(tripKey(v.tripId));
    if (!cands) continue;
    let pick = null, gap = Infinity;
    for (const i of cands) {
      const t = lineData.trips[i];
      const start = t[T_FIRST], end = start + t[T_OFFSETS][t[T_OFFSETS].length - 1];
      const g = v.tsMin < start ? start - v.tsMin : v.tsMin > end ? v.tsMin - end : 0;
      if (g < gap) { gap = g; pick = i; }
    }
    if (pick === null || gap > 60) continue;
    const t = lineData.trips[pick];
    const coords = t[T_STOPS].map((si) => {
      const s = stopsById.get(lineData.stops[si]);
      return s ? [s.lat, s.lon] : null;
    });
    const est = estimateProgress(t, coords, v);
    if (est) progress.set(pick, { ...est, tsMin: v.tsMin });
  }

  lineData.trips.forEach((t, ti) => {
    const first = t[T_FIRST];
    const offs = t[T_OFFSETS];
    if (first > nowMin + horizon || first + offs[offs.length - 1] < nowMin - 5) return;
    const nodep = new Set(t[T_NODEP]);
    const live = progress.get(ti);
    t[T_STOPS].forEach((si, pos) => {
      const poleId = lineData.stops[si];
      if (!wanted.has(poleId) || nodep.has(pos)) return;
      const sched = first + offs[pos];
      let est = sched;
      if (live) {
        if (live.passed >= pos) return; // the vehicle already left this stop
        est = sched + Math.max(live.delay, -2);
      }
      if (est < nowMin - 0.5 || sched > nowMin + horizon) return;
      result.get(poleId).push({
        headsign: lineData.headsigns[t[T_HEADSIGN]],
        sched,
        est,
        live: !!live,
        waiting: !!live?.waiting,
        delay: live ? Math.round(live.delay) : 0,
        approx: t[T_APPROX] === 1,
      });
    });
  });
  for (const [id, list] of result) result.set(id, list.sort((a, b) => a.est - b.est).slice(0, perPole));
  return result;
}

/** "сейчас", "5 мин", or clock time for anything an hour away or more. */
export function formatWait(estMin, nowMin, tz = "Europe/Warsaw") {
  const m = Math.round(estMin - nowMin);
  if (m <= 0) return "сейчас";
  if (m < 60) return `${m} мин`;
  return new Date(estMin * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} м`;
  return `${(m / 1000).toFixed(1).replace(".", ",")} км`;
}

/** Case- and diacritic-insensitive key for stop name search ("Plac Zbawiciela" ~ "pl zbaw"). */
export function searchKey(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9а-я ]/g, " ").replace(/\s+/g, " ").trim();
}

export function searchStops(stopsById, query, limit = 8) {
  const q = searchKey(query);
  if (q.length < 2) return [];
  const words = q.split(" ");
  const seen = new Map();
  for (const s of stopsById.values()) {
    const k = searchKey(s.name);
    if (!words.every((w) => k.includes(w))) continue;
    if (!seen.has(s.name)) seen.set(s.name, { name: s.name, poles: [], starts: k.startsWith(words[0]) });
    seen.get(s.name).poles.push(s);
  }
  return [...seen.values()]
    .sort((a, b) => (b.starts - a.starts) || a.name.localeCompare(b.name, "pl"))
    .slice(0, limit)
    .map((g) => ({ ...g, lat: avg(g.poles.map((p) => p.lat)), lon: avg(g.poles.map((p) => p.lon)) }));
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

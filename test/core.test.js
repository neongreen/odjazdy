import test from "node:test";
import assert from "node:assert/strict";
import {
  confidentMatch, departures, estimateProgress, formatWait, indexStops, nearestGroups, normalizeLine, polesForLine, rankStopNames, searchStops, tripKey,
} from "../public/core.js";
import { filterFeed, lineOfTrip } from "../src/worker.js";

// Three stops ~1.1 km apart on a north-south line.
const stops = indexStops([
  ["A1", "Alfa", "01", 52.2, 21.0, ["175"]],
  ["B1", "Beta", "01", 52.21, 21.0, ["175", "9"]],
  ["B2", "Beta", "02", 52.2101, 21.0003, ["9"]],
  ["C1", "Gamma", "01", 52.22, 21.0, ["175"]],
]);
const T0 = 29_000_000; // Unix minutes
const line = {
  line: "175",
  stops: ["A1", "B1", "C1"],
  headsigns: ["Gamma"],
  trips: [
    ["2026-10-09:175:PtS:1:1000", 0, T0, [0, 1, 2], [0, 5, 10], [2], 0],
    ["2026-10-09:175:PtS:2:1010", 0, T0 + 10, [0, 1, 2], [0, 5, 10], [2], 0],
  ],
};
const coords = [[52.2, 21.0], [52.21, 21.0], [52.22, 21.0]];

test("normalizeLine uppercases and trims", () => {
  assert.equal(normalizeLine(" n01 "), "N01");
});

test("tripKey drops the date so realtime and timetable ids line up", () => {
  assert.equal(tripKey("2026-10-10:175:PcS:1:1000"), "175:PcS:1:1000");
  assert.equal(tripKey(null), null);
});

test("nearestGroups groups poles by name, nearest first", () => {
  const g = nearestGroups(stops, 52.209, 21.0, { limit: 2 });
  assert.equal(g[0].name, "Beta");
  assert.deepEqual(g[0].lines.sort(), ["175", "9"]);
  assert.equal(g[0].poles.length, 2);
  assert.equal(g[1].name, "Alfa");
});

test("polesForLine falls back to the nearest poles when none are close", () => {
  const far = polesForLine(stops, "175", 52.3, 21.0, { radius: 900, min: 2 });
  assert.deepEqual(far.map((p) => p.id), ["C1", "B1"]);
  const near = polesForLine(stops, "175", 52.2, 21.0, { radius: 1200, min: 1 });
  assert.deepEqual(near.map((p) => p.id), ["A1", "B1"]);
});

test("estimateProgress: vehicle halfway between A and B two minutes late", () => {
  // Schedule puts it halfway at T0+2.5; observed at T0+4.5.
  const p = estimateProgress(line.trips[0], coords, { lat: 52.205, lon: 21.0, tsMin: T0 + 4.5 });
  assert.ok(Math.abs(p.delay - 2) < 0.05, `delay ${p.delay}`);
  assert.equal(p.passed, 0);
});

test("estimateProgress: off-route vehicle gives no estimate", () => {
  assert.equal(estimateProgress(line.trips[0], coords, { lat: 52.205, lon: 21.02, tsMin: T0 }), null);
});

test("estimateProgress: waiting at the first stop is never early", () => {
  const p = estimateProgress(line.trips[0], coords, { lat: 52.2, lon: 21.0, tsMin: T0 - 3 });
  assert.equal(p.delay, 0);
  assert.equal(p.passed, -1);
});

test("departures: scheduled only, sorted, terminus excluded", () => {
  const d = departures(line, stops, ["B1", "C1"], [], T0);
  assert.deepEqual(d.get("B1").map((x) => x.est), [T0 + 5, T0 + 15]);
  assert.equal(d.get("C1").length, 0);
  assert.equal(d.get("B1")[0].live, false);
});

test("departures: live delay shifts the estimate and passed trips disappear", () => {
  const vehicles = [
    // Trip 1 already past Beta, heading to Gamma.
    { tripId: "2026-10-09:175:PtS:1:1000", lat: 52.215, lon: 21.0, tsMin: T0 + 7.5 },
    // Trip 2 (realtime id carries another date) halfway A->B, 3 min late.
    { tripId: "2026-10-10:175:PtS:2:1010", lat: 52.205, lon: 21.0, tsMin: T0 + 15.5 },
  ];
  const d = departures(line, stops, ["B1"], vehicles, T0 + 15.5).get("B1");
  assert.equal(d.length, 1);
  assert.equal(d[0].live, true);
  assert.equal(d[0].delay, 3);
  assert.ok(Math.abs(d[0].est - (T0 + 18)) < 0.05);
});

test("formatWait", () => {
  assert.equal(formatWait(T0, T0), "сейчас");
  assert.equal(formatWait(T0 + 7.2, T0), "7 мин");
  assert.match(formatWait(T0 + 90, T0), /^\d\d:\d\d$/);
});

test("searchStops ignores case and Polish diacritics", () => {
  const s = indexStops([["X", "Plac Zbawiciela", "01", 52.2, 21.0, []], ["Y", "Łazienki Królewskie", "01", 52.21, 21.03, []]]);
  assert.equal(searchStops(s, "pl zbaw")[0].name, "Plac Zbawiciela");
  assert.equal(searchStops(s, "lazienki")[0].name, "Łazienki Królewskie");
});

test("worker filters the vehicle feed by line", () => {
  assert.equal(lineOfTrip("2026-10-09:N01:NdS:1:0100"), "N01");
  const out = filterFeed({ time: "t", positions: [
    { trip_id: "2026-10-09:175:PtS:1:1000", lat: 1, lon: 2, timestamp: "x", side_number: "1" },
    { trip_id: "2026-10-09:17:PtS:1:1000", lat: 1, lon: 2, timestamp: "x" },
  ] }, "175");
  assert.equal(out.vehicles.length, 1);
  assert.equal(out.vehicles[0].tripId, "2026-10-09:175:PtS:1:1000");
});

test("estimateProgress: implausibly early match is discarded", () => {
  // Halfway B->C is scheduled at T0-2.5; being there at T0-9 would be 6.5 min early.
  const trip = ["x", 0, T0 - 10, [0, 1, 2], [0, 5, 10], [2], 0];
  assert.equal(estimateProgress(trip, coords, { lat: 52.215, lon: 21.0, tsMin: T0 - 9 }), null);
});

test("estimateProgress: before the scheduled start the vehicle counts as waiting", () => {
  const p = estimateProgress(line.trips[0], coords, { lat: 52.2005, lon: 21.0, tsMin: T0 - 4 });
  assert.deepEqual(p, { delay: 0, passed: -1, waiting: true });
});

test("estimateProgress: vehicle just past a stop is on the next segment, not the previous endpoint", () => {
  // ~111 m north of Beta, i.e. already left Beta. Observed at T0+5 exactly when Beta was scheduled,
  // which would make the previous segment's endpoint look like a perfect time match.
  const p = estimateProgress(line.trips[0], coords, { lat: 52.211, lon: 21.0, tsMin: T0 + 5 });
  assert.equal(p.passed, 1);
});

test("departures: a late trip stays listed after its scheduled terminus time", () => {
  // Trip 1 runs 20 min late: it is halfway A->B at T0+22.5, its timetable ended at T0+10.
  const v = [{ tripId: "2026-10-09:175:PtS:1:1000", lat: 52.205, lon: 21.0, tsMin: T0 + 22.5 }];
  const d = departures(line, stops, ["B1"], v, T0 + 22.5).get("B1");
  assert.equal(d[0].live, true);
  assert.equal(d[0].delay, 20);
});

test("estimateProgress: 50 m past a stop (between standing tolerance and the tie band) counts as passed", () => {
  const p = estimateProgress(line.trips[0], coords, { lat: 52.21045, lon: 21.0, tsMin: T0 + 5 });
  assert.equal(p.passed, 1);
  const d = departures(line, stops, ["B1"], [{ tripId: line.trips[0][0], lat: 52.21045, lon: 21.0, tsMin: T0 + 5 }], T0 + 5).get("B1");
  assert.ok(d.every((x) => x.sched !== T0 + 5), "the passed trip must not be listed at B");
});

test("estimateProgress: 50 m before a stop has not passed it", () => {
  const p = estimateProgress(line.trips[0], coords, { lat: 52.20955, lon: 21.0, tsMin: T0 + 5 });
  assert.equal(p.passed, 0);
});

test("estimateProgress: standing at a stop has not passed it", () => {
  const p = estimateProgress(line.trips[0], coords, { lat: 52.21, lon: 21.0, tsMin: T0 + 5 });
  assert.equal(p.passed, 0);
});

test("searchStops: Russian spelling, ZTM abbreviations and sound-alike fallback", () => {
  const s = indexStops([
    ["T1", "Tarchomin", "01", 52.318, 20.953, []],
    ["K1", "Kępa Tarchomińska", "01", 52.348, 20.925, []],
    ["O1", "Orchowiecka", "01", 52.343, 20.973, []],
    ["Z1", "Pl. Zbawiciela", "01", 52.219, 21.015, []],
    ["G1", "Pl. Grzybowski", "01", 52.236, 21.003, []],
    ["D1", "Dw. Centralny", "01", 52.228, 21.003, []],
  ]);
  const names = (q) => searchStops(s, q).map((g) => g.name);
  assert.deepEqual(names("Тархомен"), ["Tarchomin", "Kępa Tarchomińska"]); // misspelt Cyrillic, nearest-sounding first
  assert.deepEqual(names("тархомин"), ["Tarchomin", "Kępa Tarchomińska"]);
  assert.deepEqual(names("Орховецка"), ["Orchowiecka"]);
  assert.deepEqual(names("плац збавичеля"), ["Pl. Zbawiciela"]);
  assert.deepEqual(names("дворзец центральны"), ["Dw. Centralny"]);
  // A query that matches as typed does not drag in sound-alikes (Grzybowski ~ "zb").
  assert.deepEqual(names("pl zbaw"), ["Pl. Zbawiciela"]);
});

test("rankStopNames: dictated Russian resolves to the Polish stop name", () => {
  const s = indexStops([
    ["O1", "Orchowiecka", "01", 52.343, 20.973, []],
    ["R1", "Rakowiecka", "01", 52.2, 21.0, []],
    ["T1", "Tarchomin", "01", 52.318, 20.953, []],
    ["D1", "Dw. Centralny", "01", 52.228, 21.003, []],
    ["W1", "Warszawa Wschodnia", "01", 52.25, 21.05, []],
    ["W2", "Warszawa Zachodnia", "01", 52.22, 20.96, []],
  ]);
  const top = (alts) => rankStopNames(s, alts)[0]?.name;
  assert.equal(top(["Арховецка"]), "Orchowiecka"); // misheard first vowel
  assert.ok(confidentMatch(rankStopNames(s, ["Арховецка"])));
  assert.equal(top(["остановка Тархомин"]), "Tarchomin"); // filler word ignored
  assert.equal(top(["центральный вокзал"]), "Dw. Centralny"); // Russian word + word order
  assert.equal(top(["что-то совсем другое", "Варшава Восточная"]), "Warszawa Wschodnia"); // any alternative can win
  assert.deepEqual(rankStopNames(s, ["ну"]), []);
});

test("confidentMatch needs a clear winner", () => {
  assert.equal(confidentMatch([{ score: 0.9 }, { score: 0.85 }]), false);
  assert.equal(confidentMatch([{ score: 0.7 }]), false);
  assert.equal(confidentMatch([{ score: 1 }, { score: 0.8 }]), true);
});

test("rankStopNames keeps a full stop name that contains a filler word", () => {
  const s = indexStops([
    ["M1", "Metro Ratusz Arsenał", "01", 52.245, 21.0, []],
    ["R1", "Ratusz Arsenał", "01", 52.245, 21.001, []],
    ["K1", "Kabaty", "01", 52.13, 21.06, []],
  ]);
  const r = rankStopNames(s, ["Metro Ratusz Arsenał"]);
  assert.equal(r[0].name, "Metro Ratusz Arsenał");
  assert.ok(confidentMatch(r));
  assert.equal(rankStopNames(s, ["Ratusz Arsenał"])[0].name, "Ratusz Arsenał");
  assert.equal(rankStopNames(s, ["метро Кабаты"])[0].name, "Kabaty"); // "metro" as a filler still works
});

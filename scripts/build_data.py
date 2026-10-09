#!/usr/bin/env python3
"""Convert the Warsaw GTFS feed (mkuran.pl) into the static JSON the site reads.

Output (under OUT_DIR):
  data/index.json         stops, lines, feed metadata
  data/lines/<line>.json  every trip of that line in the build window

Times are absolute: each trip stores its first departure as Unix minutes (UTC)
and per-stop offsets in minutes. The window covers trips that are still running
or will run from the build moment until the end of the next service day, so a
single missed daily rebuild still leaves a full day of data.

Usage: build_data.py <gtfs.zip or directory> <out dir> [--now ISO8601]
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Warsaw")
# Keep trips that ended at most this long before the build moment.
PAST_GRACE_MIN = 30


class Feed:
    """Reads GTFS tables from a zip file or an unpacked directory."""

    def __init__(self, path: str):
        self.path = path
        self.zip = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None

    def rows(self, name: str):
        if self.zip:
            with self.zip.open(name) as raw:
                yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"))
        else:
            with open(os.path.join(self.path, name), encoding="utf-8-sig", newline="") as f:
                yield from csv.DictReader(f)

    def has(self, name: str) -> bool:
        if self.zip:
            return name in self.zip.namelist()
        return os.path.exists(os.path.join(self.path, name))


def parse_hms(s: str) -> int:
    """GTFS time (may exceed 24:00) to seconds after service-day reference."""
    h, m, sec = (int(x) for x in s.split(":"))
    return h * 3600 + m * 60 + sec


def service_day_reference(d: date) -> int:
    """Unix seconds of "noon minus 12 hours" on service date d (GTFS definition)."""
    noon = datetime.combine(d, time(12, 0), TZ)
    return int(noon.timestamp()) - 12 * 3600


def safe_line_name(line: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in line)


def build(feed: Feed, now: datetime) -> dict:
    now_local = now.astimezone(TZ)
    today = now_local.date()
    dates = [today - timedelta(days=1), today, today + timedelta(days=1)]
    window_start = int(now.timestamp()) - PAST_GRACE_MIN * 60
    window_end = service_day_reference(today + timedelta(days=2)) + 4 * 3600

    services: dict[str, list[date]] = defaultdict(list)
    wanted = {d.strftime("%Y%m%d"): d for d in dates}
    for r in feed.rows("calendar_dates.txt"):
        if r["exception_type"] == "1" and r["date"] in wanted:
            services[r["service_id"]].append(wanted[r["date"]])
    if feed.has("calendar.txt"):
        days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        removed = {(r["service_id"], r["date"]) for r in feed.rows("calendar_dates.txt") if r["exception_type"] == "2"}
        for r in feed.rows("calendar.txt"):
            for d in dates:
                ds = d.strftime("%Y%m%d")
                if r["start_date"] <= ds <= r["end_date"] and r[days[d.weekday()]] == "1" and (r["service_id"], ds) not in removed:
                    services[r["service_id"]].append(d)

    routes = {}
    for r in feed.rows("routes.txt"):
        routes[r["route_id"]] = {
            "line": r["route_short_name"] or r["route_id"],
            "type": int(r["route_type"]),
            "color": r.get("route_color") or "",
            "name": r.get("route_long_name") or "",
        }

    trips = {}
    for r in feed.rows("trips.txt"):
        days = services.get(r["service_id"])
        if days:
            trips[r["trip_id"]] = (r["route_id"], r["trip_headsign"], days)

    frequencies = defaultdict(list)
    if feed.has("frequencies.txt"):
        for r in feed.rows("frequencies.txt"):
            if r["trip_id"] in trips:
                frequencies[r["trip_id"]].append((parse_hms(r["start_time"]), parse_hms(r["end_time"]), int(r["headway_secs"])))

    stop_times = defaultdict(list)
    for r in feed.rows("stop_times.txt"):
        tid = r["trip_id"]
        if tid in trips:
            dep = r["departure_time"] or r["arrival_time"]
            if dep:
                stop_times[tid].append((int(r["stop_sequence"]), r["stop_id"], parse_hms(dep), r.get("pickup_type", "0")))

    # Expand (trip, service date) and frequency templates into concrete runs.
    runs_by_route = defaultdict(list)
    for tid, (route_id, headsign, days) in trips.items():
        st = sorted(stop_times.get(tid, []))
        if len(st) < 2:
            continue
        base = st[0][2]
        starts = [(base, tid, False)]
        if tid in frequencies:
            starts = []
            for start, end, headway in frequencies[tid]:
                t = start
                while t < end:
                    starts.append((t, None, True))
                    t += headway
        for d in days:
            ref = service_day_reference(d)
            for start, run_tid, approx in starts:
                shift = start - base
                first = ref + base + shift
                last = ref + st[-1][2] + shift
                if last < window_start or first > window_end:
                    continue
                runs_by_route[route_id].append({
                    "tid": run_tid,
                    "headsign": headsign,
                    "first": first,
                    "stops": [s[1] for s in st],
                    "offsets": [(s[2] - st[0][2]) // 60 for s in st],
                    # Last stop of a trip and no-pickup stops are not departures.
                    "nodep": [i for i, s in enumerate(st) if s[3] == "1" or i == len(st) - 1],
                    "approx": approx,
                })

    used_stops = set()
    lines_out = {}
    for route_id, runs in runs_by_route.items():
        info = routes.get(route_id)
        if not info:
            continue
        runs.sort(key=lambda r: r["first"])
        headsigns: list[str] = []
        hs_index = {}
        stop_list: list[str] = []
        stop_index = {}
        trips_out = []
        for run in runs:
            if run["headsign"] not in hs_index:
                hs_index[run["headsign"]] = len(headsigns)
                headsigns.append(run["headsign"])
            idx = []
            for s in run["stops"]:
                if s not in stop_index:
                    stop_index[s] = len(stop_list)
                    stop_list.append(s)
                idx.append(stop_index[s])
            # [tripId|null, headsignIdx, firstUnixMinute, stopIdx[], offsetMin[], noDepartureIdx[], approx(0|1)]
            trips_out.append([run["tid"], hs_index[run["headsign"]], run["first"] // 60, idx, run["offsets"], run["nodep"], 1 if run["approx"] else 0])
        used_stops.update(stop_list)
        lines_out[info["line"]] = {
            "line": info["line"],
            "type": info["type"],
            "color": info["color"],
            "name": info["name"],
            "stops": stop_list,
            "headsigns": headsigns,
            "trips": trips_out,
        }

    stops_out = []
    stop_lines = defaultdict(set)
    for line, data in lines_out.items():
        for s in data["stops"]:
            stop_lines[s].add(line)
    for r in feed.rows("stops.txt"):
        sid = r["stop_id"]
        if sid not in used_stops:
            continue
        # [id, name, pole code, lat, lon, lines[]]
        stops_out.append([sid, r["stop_name"], r.get("stop_code") or r.get("platform_code") or "", round(float(r["stop_lat"]), 6), round(float(r["stop_lon"]), 6), sorted(stop_lines[sid], key=line_sort_key)])

    feed_version = ""
    if feed.has("feed_info.txt"):
        for r in feed.rows("feed_info.txt"):
            feed_version = r.get("feed_version", "")
    index = {
        "generatedAt": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "feedVersion": feed_version,
        "validUntil": window_end // 60,
        "lines": sorted(([d["line"], d["type"], d["color"], d["name"]] for d in lines_out.values()), key=lambda x: line_sort_key(x[0])),
        "stops": stops_out,
    }
    return {"index": index, "lines": lines_out}


def line_sort_key(line: str):
    digits = "".join(c for c in line if c.isdigit())
    return (0 if line.isdigit() else 1, line.rstrip("0123456789"), int(digits) if digits else 0, line)


def write(result: dict, out_dir: str) -> None:
    data_dir = os.path.join(out_dir, "data")
    lines_dir = os.path.join(data_dir, "lines")
    os.makedirs(lines_dir, exist_ok=True)
    with open(os.path.join(data_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(result["index"], f, ensure_ascii=False, separators=(",", ":"))
    for line, data in result["lines"].items():
        with open(os.path.join(lines_dir, safe_line_name(line) + ".json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    now = datetime.now(timezone.utc)
    if "--now" in argv:
        now = datetime.fromisoformat(argv[argv.index("--now") + 1])
    result = build(Feed(argv[1]), now)
    write(result, argv[2])
    print(f"lines={len(result['lines'])} stops={len(result['index']['stops'])} trips={sum(len(l['trips']) for l in result['lines'].values())}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

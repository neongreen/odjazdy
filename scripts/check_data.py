#!/usr/bin/env python3
"""Fails the deploy when the built index would leave the site without upcoming departures."""

import json
import sys
import time

index = json.load(open(sys.argv[1], encoding="utf-8"))
now_min = time.time() / 60
problems = []
if len(index["stops"]) < 1000:
    problems.append(f"only {len(index['stops'])} stops")
if len(index["lines"]) < 100:
    problems.append(f"only {len(index['lines'])} lines")
if index["validUntil"] - now_min < 12 * 60:
    problems.append("timetable window ends within 12 hours")
if problems:
    sys.exit("data check failed: " + "; ".join(problems))
print(f"ok: {len(index['stops'])} stops, {len(index['lines'])} lines, valid {int((index['validUntil'] - now_min) / 60)} h ahead")

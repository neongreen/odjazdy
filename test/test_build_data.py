import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import build_data  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixture")


def unix_min(s):
    return int(datetime.fromisoformat(s).timestamp()) // 60


class BuildDataTest(unittest.TestCase):
    def setUp(self):
        # 09:00 in Warsaw (CEST, UTC+2) on Friday 2026-10-09.
        self.result = build_data.build(build_data.Feed(FIXTURE), datetime(2026, 10, 9, 7, 0, tzinfo=timezone.utc))

    def test_drops_finished_trips_and_keeps_upcoming(self):
        trips = self.result["lines"]["175"]["trips"]
        ids = [t[0] for t in trips]
        self.assertNotIn("2026-10-09:175:PtS:1:0800", ids)
        self.assertIn("2026-10-09:175:PtS:1:1000", ids)
        today = trips[ids.index("2026-10-09:175:PtS:1:1000")]
        self.assertEqual(today[2], unix_min("2026-10-09T10:00:00+02:00"))
        self.assertEqual(today[4], [0, 5, 10])

    def test_times_past_midnight_and_no_pickup(self):
        trips = self.result["lines"]["175"]["trips"]
        late = next(t for t in trips if t[0] == "2026-10-10:175:SbS:1:1000")
        self.assertEqual(late[2], unix_min("2026-10-11T00:30:00+02:00"))
        self.assertEqual(late[5], [1, 2])  # no-pickup stop and the terminus are not departures

    def test_frequencies_expand_to_approximate_runs(self):
        metro = self.result["lines"]["M1"]["trips"]
        self.assertEqual([t[2] for t in metro], [unix_min("2026-10-09T09:00:00+02:00"), unix_min("2026-10-09T09:10:00+02:00")])
        self.assertTrue(all(t[0] is None and t[6] == 1 for t in metro))

    def test_index_lists_only_served_stops_with_lines(self):
        stops = {s[0]: s for s in self.result["index"]["stops"]}
        self.assertNotIn("900101", stops)
        self.assertEqual(stops["100101"][5], ["175"])
        self.assertEqual(stops["M01"][5], ["M1"])
        self.assertEqual([l[0] for l in self.result["index"]["lines"]], ["175", "M1"])
        self.assertEqual(self.result["index"]["feedVersion"], "fixture-1")


if __name__ == "__main__":
    unittest.main()

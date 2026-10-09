# odjazdy

Next Warsaw bus and tram departures near you, in Russian. Live at https://odjazdy.pinkfloyd.workers.dev.

The page finds the nearest stops by geolocation (or a stop name), and for a typed line shows the next departures at the closest poles in each direction.

## Data

- Timetable: ZTM Warszawa via the GTFS feed published by Mikołaj Kuranowski (https://mkuran.pl/gtfs/warsaw.zip), rebuilt daily.
- Live positions: Warsaw City Hall (api.um.warszawa.pl), republished keyed by GTFS trip id at https://mkuran.pl/gtfs/warsaw/vehicles.json.

ZTM publishes no open arrival predictions. For a trip with a live vehicle, `public/core.js` projects the vehicle onto the trip's stop sequence, compares against the timetable, and shifts the remaining stop times by that delay. Trips without a live vehicle show the timetable. Metro runs come from GTFS frequencies and are marked approximate.

## Layout

- `scripts/build_data.py` converts the GTFS zip into `build/data/index.json` (stops, lines) and `build/data/lines/<line>.json` (trips from now to the end of the next service day, absolute Unix minutes).
- `scripts/check_data.py` refuses to deploy an index that is too small or expires within 12 hours.
- `public/` is the static page; `public/core.js` holds all logic that is unit tested.
- `src/worker.js` serves the assets and `GET /api/vehicles?line=N`, a filtered, 10-second-cached copy of the live feed.
- `.github/workflows/deploy.yml` tests every push and PR; on `main` (push, 00:40 and 12:40 UTC daily) it rebuilds the data and deploys with Wrangler. Needs repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Commands

```sh
npm ci
npm test                                         # node:test + python unittest
curl -fsSLo warsaw.zip https://mkuran.pl/gtfs/warsaw.zip
python3 scripts/build_data.py warsaw.zip build   # ~20 s
npm run assemble && npx wrangler deploy
```

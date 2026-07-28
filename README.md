# DangerSphere

Live multi-hazard command surface — a holographic 3D globe of earthquakes, wildfires, tropical cyclones, volcanoes, and tsunamis, with city-level climate insights.

![stack](https://img.shields.io/badge/stack-FastAPI%20%7C%20Globe.gl%20%7C%20Docker-2fe8ff?style=flat-square)

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

Open [http://localhost:8000](http://localhost:8000).

The scraper runs on startup and every 15 minutes. First `/data/live_disasters.json` may be empty for a few seconds.

### Local scraper only (no Docker)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
python scraper.py
```

## NASA FIRMS MAP_KEY (wildfires)

Wildfire hotspots require a free FIRMS key. Without it, earthquakes / cyclones / volcanoes / tsunamis still load; wildfires are skipped (`sources.firms: skipped_no_key`).

1. Open [https://firms.modaps.eosdis.nasa.gov/api/map_key/](https://firms.modaps.eosdis.nasa.gov/api/map_key/)
2. Request a free **MAP_KEY** (sent by email).
3. Copy `.env.example` → `.env` and set:

   ```env
   NASA_FIRMS_MAP_KEY=your_key_here
   ```

4. Restart: `docker compose up -d --build`
5. Confirm: `curl http://localhost:8000/health` shows `"firms"` activity, or inspect `/data/live_disasters.json` for `"firms": "ok"` and `type: "wildfire"` events.

Rate limit is generous (~5000 transactions / 10 minutes). DangerSphere polls about once per 15 minutes.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NASA_FIRMS_MAP_KEY` | _(empty)_ | FIRMS API key; wildfires skipped if unset |
| `CACHE_PATH` | `/app/data/live_disasters.json.gz` | Gzipped live event cache |
| `SCRAPE_INTERVAL_SECONDS` | `900` | Scrape cadence |
| `FIRMS_MAX_POINTS` | `5000` | Cap on wildfire points retained |
| `NASA_FIRMS_SOURCE` | `VIIRS_SNPP_NRT` | FIRMS sensor product |
| `HTTP_TIMEOUT_SECONDS` | `45` | Outbound HTTP timeout |

## Hazard legend

| Layer | Color | Source |
|---|---|---|
| Earthquakes | Red pulse rings | USGS M2.5+ day feed |
| Wildfires | Amber points | NASA FIRMS (key required) |
| Hurricanes | Cyan paths | GDACS TC |
| Volcanoes | Magenta markers | GDACS VO + USGS elevated |
| Tsunamis | Blue alert rings | GDACS TS |
| Radar | Precipitation tiles | [RainViewer](https://www.rainviewer.com/) (free, personal use) |

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Status, `last_updated`, event counts |
| `GET /data/live_disasters.json` | Normalised live hazard cache |
| `GET /api/cities` | Curated major cities |
| `GET /api/insights?city_id=tokyo` | Climate context vs prior-year window (Open-Meteo) |
| `GET /api/historical?lat=&lon=&start_date=&end_date=` | Thin Open-Meteo archive proxy |

## City insights

Click a city pin (or search in the HUD). A side panel shows:

- Plain-language climate summaries (recent 90 days vs same window a year earlier)
- Temperature / precipitation charts
- Nearby live hazards within ~750 km

Historical data is **not** painted on the globe — live hazards stay the star.

## Deploy notes (for private ops workspace)

Compose service name: **`dangersphere`**

- Internal port: `8000`
- Persist volume: `./data` → `/app/data`
- Health check: `GET /health`
- Optional: serve `frontend/` from Nginx later; keep this container as scraper + API host
- Memory limit in compose: `256m` (tune with `docker stats`)

Point your reverse proxy at `dangersphere:8000` on the internal Docker network.

## Attribution

USGS · NASA FIRMS · GDACS · [Open-Meteo](https://open-meteo.com/) · [RainViewer](https://www.rainviewer.com/) · [Globe.gl](https://globe.gl/) / three-globe textures

## License

MIT — see [LICENSE](LICENSE).

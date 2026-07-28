"""DangerSphere configuration — env-driven constants."""

import os

CACHE_PATH = os.getenv("CACHE_PATH", "/app/data/live_disasters.json.gz")
SCRAPE_INTERVAL_SECONDS = int(os.getenv("SCRAPE_INTERVAL_SECONDS", str(15 * 60)))

# USGS earthquakes (M2.5+ past day)
USGS_URL = (
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
)

# NASA FIRMS (optional MAP_KEY)
NASA_FIRMS_MAP_KEY = os.getenv("NASA_FIRMS_MAP_KEY", "").strip()
NASA_FIRMS_SOURCE = os.getenv("NASA_FIRMS_SOURCE", "VIIRS_SNPP_NRT")
NASA_FIRMS_DAY_RANGE = int(os.getenv("NASA_FIRMS_DAY_RANGE", "1"))
FIRMS_MAX_POINTS = int(os.getenv("FIRMS_MAX_POINTS", "5000"))

# GDACS GeoJSON search (tropical cyclones, volcanoes, tsunamis)
GDACS_SEARCH_URL = (
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
)
GDACS_EVENT_URL = (
    "https://www.gdacs.org/gdacsapi/api/events/geteventdata"
)

# USGS elevated volcanoes (US monitors)
USGS_VOLCANO_GEOJSON = (
    "https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson"
)

# Open-Meteo historical archive
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# HTTP client
HTTP_TIMEOUT_SECONDS = float(os.getenv("HTTP_TIMEOUT_SECONDS", "30"))
HTTP_USER_AGENT = "DangerSphere/1.0 (+https://github.com/ObiRonKenobi/DangerSphere)"

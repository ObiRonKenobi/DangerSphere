"""DangerSphere FastAPI application — API, insights proxy, static frontend."""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import aiohttp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import settings
from cities import get_city, list_cities
from scraper import scraper_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("dangersphere")


def _frontend_path() -> Path:
    # Prefer sibling frontend/ (compose mount or repo layout)
    candidates = [
        Path(__file__).resolve().parent.parent / "frontend",
        Path("/app/frontend"),
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def _read_cache() -> dict[str, Any]:
    cache = Path(settings.CACHE_PATH)
    if not cache.exists():
        return {"last_updated": None, "sources": {}, "events": []}
    with gzip.open(cache, "rt", encoding="utf-8") as f:
        return json.load(f)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(scraper_loop())
    logger.info("Scraper loop started")
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    logger.info("Scraper loop stopped")


app = FastAPI(title="DangerSphere", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    data = _read_cache()
    events = data.get("events") or []
    counts: dict[str, int] = {}
    for ev in events:
        t = ev.get("type") or "unknown"
        counts[t] = counts.get(t, 0) + 1
    return {
        "status": "ok",
        "last_updated": data.get("last_updated"),
        "event_counts": counts,
        "sources": data.get("sources") or {},
    }


@app.get("/data/live_disasters.json")
async def get_live_data():
    return JSONResponse(content=_read_cache())


@app.get("/api/cities")
async def api_cities():
    return {"cities": list_cities()}


@app.get("/api/historical")
async def historical_proxy(
    lat: float = Query(...),
    lon: float = Query(...),
    start_date: str = Query(..., pattern=r"\d{4}-\d{2}-\d{2}"),
    end_date: str = Query(..., pattern=r"\d{4}-\d{2}-\d{2}"),
):
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "daily": "temperature_2m_mean,precipitation_sum",
        "timezone": "UTC",
    }
    timeout = aiohttp.ClientTimeout(total=settings.HTTP_TIMEOUT_SECONDS)
    headers = {"User-Agent": settings.HTTP_USER_AGENT}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async with session.get(
            settings.OPEN_METEO_ARCHIVE_URL, params=params
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise HTTPException(
                    status_code=502,
                    detail=f"Open-Meteo error {resp.status}: {body[:200]}",
                )
            data = await resp.json(content_type=None)
    return JSONResponse(content=data)


def _mean(values: list[float | None]) -> float | None:
    nums = [v for v in values if v is not None]
    if not nums:
        return None
    return sum(nums) / len(nums)


def _summarize_climate(
    recent: dict[str, Any],
    baseline: dict[str, Any],
    city_name: str,
) -> list[str]:
    """Plain-language insight lines from recent vs baseline series."""
    lines: list[str] = []
    r_daily = recent.get("daily") or {}
    b_daily = baseline.get("daily") or {}

    r_temp = _mean(r_daily.get("temperature_2m_mean") or [])
    b_temp = _mean(b_daily.get("temperature_2m_mean") or [])
    r_precip = _mean(r_daily.get("precipitation_sum") or [])
    b_precip = _mean(b_daily.get("precipitation_sum") or [])

    if r_temp is not None and b_temp is not None:
        delta = r_temp - b_temp
        direction = "warmer" if delta > 0 else "cooler"
        lines.append(
            f"{city_name}: recent 90-day mean temperature is {abs(delta):.1f}°C "
            f"{direction} than the prior-year same window ({r_temp:.1f}°C vs {b_temp:.1f}°C)."
        )
    elif r_temp is not None:
        lines.append(
            f"{city_name}: recent 90-day mean temperature is {r_temp:.1f}°C."
        )

    if r_precip is not None and b_precip is not None:
        if b_precip > 0.05:
            pct = ((r_precip - b_precip) / b_precip) * 100
            wetter = "wetter" if pct > 0 else "drier"
            lines.append(
                f"Daily precipitation averaged {r_precip:.2f} mm "
                f"({abs(pct):.0f}% {wetter} than the prior-year window)."
            )
        else:
            lines.append(
                f"Daily precipitation averaged {r_precip:.2f} mm over the recent window."
            )

    if not lines:
        lines.append(f"Climate series loaded for {city_name}.")
    return lines


@app.get("/api/insights")
async def api_insights(
    city_id: str | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
):
    city = None
    if city_id:
        city = get_city(city_id)
        if not city:
            raise HTTPException(status_code=404, detail=f"Unknown city_id: {city_id}")
        lat = city["lat"]
        lon = city["lon"]
    elif lat is None or lon is None:
        raise HTTPException(
            status_code=400, detail="Provide city_id or both lat and lon"
        )

    today = date.today()
    recent_end = today - timedelta(days=5)  # archive lag
    recent_start = recent_end - timedelta(days=89)
    baseline_end = recent_end - timedelta(days=365)
    baseline_start = recent_start - timedelta(days=365)

    async def _fetch_window(
        session: aiohttp.ClientSession, start: date, end: date
    ) -> dict[str, Any]:
        params = {
            "latitude": lat,
            "longitude": lon,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "daily": "temperature_2m_mean,precipitation_sum",
            "timezone": "UTC",
        }
        async with session.get(
            settings.OPEN_METEO_ARCHIVE_URL, params=params
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise HTTPException(
                    status_code=502,
                    detail=f"Open-Meteo error {resp.status}: {body[:200]}",
                )
            return await resp.json(content_type=None)

    timeout = aiohttp.ClientTimeout(total=settings.HTTP_TIMEOUT_SECONDS)
    headers = {"User-Agent": settings.HTTP_USER_AGENT}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        recent, baseline = await asyncio.gather(
            _fetch_window(session, recent_start, recent_end),
            _fetch_window(session, baseline_start, baseline_end),
        )

    name = city["name"] if city else f"{lat:.2f},{lon:.2f}"
    summaries = _summarize_climate(recent, baseline, name)

    return {
        "city": city,
        "location": {"lat": lat, "lon": lon},
        "windows": {
            "recent": {
                "start": recent_start.isoformat(),
                "end": recent_end.isoformat(),
            },
            "baseline": {
                "start": baseline_start.isoformat(),
                "end": baseline_end.isoformat(),
            },
        },
        "recent": recent,
        "baseline": baseline,
        "summaries": summaries,
    }


# API routes registered above; mount static last so it cannot shadow them.
frontend = _frontend_path()
if frontend.exists():
    assets = frontend / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(frontend / "index.html")

    @app.get("/{path:path}")
    async def static_files(path: str):
        # Do not steal API/data paths (already matched above if exact).
        blocked = ("api/", "data/", "health", "docs", "openapi.json", "redoc")
        if path.startswith(blocked) or path in {"health", "docs", "redoc", "openapi.json"}:
            raise HTTPException(status_code=404)
        target = (frontend / path).resolve()
        if not str(target).startswith(str(frontend.resolve())):
            raise HTTPException(status_code=404)
        if target.is_file():
            return FileResponse(target)
        raise HTTPException(status_code=404)
else:
    logger.warning("Frontend directory not found at %s", frontend)

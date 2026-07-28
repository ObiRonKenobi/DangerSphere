"""DangerSphere live hazard scrapers — USGS, NASA FIRMS, GDACS, USGS volcanoes."""

from __future__ import annotations

import asyncio
import csv
import gzip
import io
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiohttp

import settings
from settings import (
    FIRMS_MAX_POINTS,
    GDACS_EVENT_URL,
    GDACS_SEARCH_URL,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    NASA_FIRMS_DAY_RANGE,
    NASA_FIRMS_MAP_KEY,
    NASA_FIRMS_SOURCE,
    SCRAPE_INTERVAL_SECONDS,
    USGS_URL,
    USGS_VOLCANO_GEOJSON,
)

logger = logging.getLogger(__name__)

ALERT_ORDINAL = {"green": 1, "yellow": 2, "orange": 3, "red": 4}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_timeout() -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SECONDS)


def _headers() -> dict[str, str]:
    return {"User-Agent": HTTP_USER_AGENT}


def _point_event(
    *,
    event_id: str,
    event_type: str,
    lon: float,
    lat: float,
    time: str,
    title: str,
    magnitude: float | None = None,
    alert_level: str | None = None,
    source_url: str = "",
    hurricane_path: list[list[float]] | None = None,
    fire_radiance: float | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    props: dict[str, Any] = {
        "time": time,
        "title": title,
        "source_url": source_url,
        "extra": extra or {},
    }
    if magnitude is not None:
        props["magnitude"] = magnitude
    if alert_level:
        props["alert_level"] = alert_level
    if hurricane_path:
        props["hurricane_path"] = hurricane_path
    if fire_radiance is not None:
        props["fire_radiance"] = fire_radiance
    return {
        "id": event_id,
        "type": event_type,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": props,
    }


async def fetch_usgs(session: aiohttp.ClientSession) -> list[dict]:
    """Normalise USGS earthquake GeoJSON."""
    async with session.get(USGS_URL) as resp:
        resp.raise_for_status()
        geojson = await resp.json(content_type=None)

    events: list[dict] = []
    for feature in geojson.get("features", []):
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        if coords[0] is None or coords[1] is None:
            continue
        mag = props.get("mag")
        time_ms = props.get("time")
        time_iso = (
            datetime.fromtimestamp(time_ms / 1000, tz=timezone.utc).isoformat()
            if time_ms
            else _utcnow_iso()
        )
        fid = str(feature.get("id") or props.get("code") or len(events))
        events.append(
            _point_event(
                event_id=f"usgs-{fid}",
                event_type="earthquake",
                lon=float(coords[0]),
                lat=float(coords[1]),
                time=time_iso,
                title=props.get("title") or f"M{mag} earthquake",
                magnitude=float(mag) if mag is not None else None,
                source_url=props.get("url") or "",
                extra={"depth_km": coords[2] if len(coords) > 2 else None},
            )
        )
    return events


def _firms_url() -> str:
    return (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{NASA_FIRMS_MAP_KEY}/{NASA_FIRMS_SOURCE}/world/{NASA_FIRMS_DAY_RANGE}"
    )


async def fetch_nasa_firms(session: aiohttp.ClientSession) -> tuple[list[dict], str]:
    """Fetch wildfire hotspots. Returns (events, status)."""
    if not NASA_FIRMS_MAP_KEY:
        logger.warning("NASA_FIRMS_MAP_KEY not set — skipping wildfire scrape")
        return [], "skipped_no_key"

    async with session.get(_firms_url()) as resp:
        text = await resp.text()
        if resp.status != 200:
            logger.error("FIRMS HTTP %s: %s", resp.status, text[:200])
            return [], f"error_http_{resp.status}"
        if text.strip().lower().startswith("<!DOCTYPE") or "Invalid" in text[:80]:
            logger.error("FIRMS rejected request: %s", text[:200])
            return [], "error_invalid_key"

    reader = csv.DictReader(io.StringIO(text))
    events: list[dict] = []
    for row in reader:
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, ValueError, TypeError):
            continue

        conf = (row.get("confidence") or "").strip().lower()
        # VIIRS: nominal/high or numeric; MODIS: 0-100
        if conf in {"l", "low"}:
            continue
        if conf.isdigit() and int(conf) < 50:
            continue

        brightness = None
        for key in ("bright_ti4", "brightness", "bright_t31"):
            if row.get(key):
                try:
                    brightness = float(row[key])
                    break
                except ValueError:
                    pass

        frp = None
        if row.get("frp"):
            try:
                frp = float(row["frp"])
            except ValueError:
                pass

        acq_date = row.get("acq_date") or ""
        acq_time = (row.get("acq_time") or "0000").zfill(4)
        try:
            dt = datetime.strptime(
                f"{acq_date}{acq_time}", "%Y-%m-%d%H%M"
            ).replace(tzinfo=timezone.utc)
            time_iso = dt.isoformat()
        except ValueError:
            time_iso = _utcnow_iso()

        sat = row.get("satellite") or NASA_FIRMS_SOURCE
        eid = f"firms-{acq_date}-{acq_time}-{lat:.3f}-{lon:.3f}-{sat}"
        events.append(
            _point_event(
                event_id=eid,
                event_type="wildfire",
                lon=lon,
                lat=lat,
                time=time_iso,
                title=f"Fire hotspot ({sat})",
                magnitude=frp if frp is not None else brightness,
                fire_radiance=frp if frp is not None else brightness,
                source_url="https://firms.modaps.eosdis.nasa.gov/",
                extra={"confidence": conf, "satellite": sat},
            )
        )
        if len(events) >= FIRMS_MAX_POINTS:
            break

    # Prefer higher FRP when over cap (already capped in loop; sort+trim if needed)
    if len(events) > FIRMS_MAX_POINTS:
        events.sort(
            key=lambda e: e["properties"].get("fire_radiance") or 0, reverse=True
        )
        events = events[:FIRMS_MAX_POINTS]

    return events, "ok"


def _gdacs_dates() -> tuple[str, str]:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=14)
    return start.isoformat(), end.isoformat()


def _extract_coords(feature: dict) -> tuple[float, float] | None:
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        props = feature.get("properties") or {}
        lat = props.get("lat") or props.get("latitude")
        lon = props.get("lon") or props.get("longitude")
        if lat is not None and lon is not None:
            return float(lon), float(lat)
        return None
    if gtype == "Point":
        return float(coords[0]), float(coords[1])
    if gtype == "Polygon" and coords and coords[0]:
        ring = coords[0]
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        return lon, lat
    if gtype == "MultiPolygon" and coords and coords[0] and coords[0][0]:
        ring = coords[0][0]
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        return lon, lat
    if gtype == "LineString" and coords:
        mid = coords[len(coords) // 2]
        return float(mid[0]), float(mid[1])
    # Fallback: first numeric pair
    flat = coords
    while isinstance(flat, list) and flat and isinstance(flat[0], list):
        flat = flat[0]
    if isinstance(flat, list) and len(flat) >= 2 and not isinstance(flat[0], list):
        return float(flat[0]), float(flat[1])
    return None


def _gdacs_type_map(eventlist: str) -> str:
    return {"TC": "hurricane", "VO": "volcano", "TS": "tsunami"}.get(
        eventlist.upper(), eventlist.lower()
    )


async def _fetch_gdacs_track(
    session: aiohttp.ClientSession, event_type: str, event_id: str
) -> list[list[float]]:
    """Best-effort track points from GDACS event detail."""
    params = {"eventtype": event_type, "eventid": event_id}
    try:
        async with session.get(GDACS_EVENT_URL, params=params) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
    except Exception:
        logger.exception("GDACS event detail failed for %s %s", event_type, event_id)
        return []

    path: list[list[float]] = []
    # Geometry may be LineString or nested under features
    if isinstance(data, dict):
        features = data.get("features")
        if isinstance(features, list):
            for feat in features:
                geom = (feat or {}).get("geometry") or {}
                if geom.get("type") == "LineString":
                    for pt in geom.get("coordinates") or []:
                        if len(pt) >= 2:
                            path.append([float(pt[0]), float(pt[1])])
                elif geom.get("type") == "Point":
                    c = geom.get("coordinates") or []
                    if len(c) >= 2:
                        path.append([float(c[0]), float(c[1])])
        geom = data.get("geometry") or {}
        if geom.get("type") == "LineString":
            for pt in geom.get("coordinates") or []:
                if len(pt) >= 2:
                    path.append([float(pt[0]), float(pt[1])])
    return path


async def fetch_gdacs(
    session: aiohttp.ClientSession, eventlist: str
) -> list[dict]:
    """Fetch GDACS events for TC, VO, or TS."""
    from_date, to_date = _gdacs_dates()
    params = {
        "eventlist": eventlist,
        "fromdate": from_date,
        "todate": to_date,
        "alertlevel": "green;orange;red;yellow",
    }
    async with session.get(GDACS_SEARCH_URL, params=params) as resp:
        resp.raise_for_status()
        data = await resp.json(content_type=None)

    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        return []

    mapped_type = _gdacs_type_map(eventlist)
    events: list[dict] = []

    for feature in features:
        props = feature.get("properties") or {}
        coords = _extract_coords(feature)
        if not coords:
            continue
        lon, lat = coords

        eid_raw = (
            props.get("eventid")
            or props.get("eventId")
            or props.get("episodeid")
            or feature.get("id")
            or len(events)
        )
        name = (
            props.get("name")
            or props.get("eventname")
            or props.get("htmldescription")
            or f"{mapped_type.title()} event"
        )
        alert = (props.get("alertlevel") or props.get("alertLevel") or "").lower() or None
        severity = props.get("severity") or props.get("severitydata") or {}
        mag = None
        if isinstance(severity, dict):
            val = severity.get("value") or severity.get("severity")
            try:
                mag = float(val) if val is not None else None
            except (TypeError, ValueError):
                mag = None
        if mag is None and alert:
            mag = float(ALERT_ORDINAL.get(alert, 1))

        fromdate = props.get("fromdate") or props.get("date") or _utcnow_iso()
        if isinstance(fromdate, str) and "T" not in fromdate:
            fromdate = f"{fromdate}T00:00:00+00:00"

        url = props.get("url") or props.get("link") or ""
        if isinstance(url, dict):
            url = url.get("report") or url.get("geometry") or ""

        hurricane_path = None
        if eventlist.upper() == "TC":
            hurricane_path = await _fetch_gdacs_track(
                session, "TC", str(eid_raw)
            )
            if not hurricane_path:
                hurricane_path = [[lon, lat]]

        events.append(
            _point_event(
                event_id=f"gdacs-{eventlist.lower()}-{eid_raw}",
                event_type=mapped_type,
                lon=lon,
                lat=lat,
                time=str(fromdate),
                title=str(name)[:200],
                magnitude=mag,
                alert_level=alert,
                source_url=str(url),
                hurricane_path=hurricane_path,
                extra={"gdacs_eventlist": eventlist},
            )
        )
    return events


async def fetch_usgs_volcanoes(session: aiohttp.ClientSession) -> list[dict]:
    """US elevated volcanoes from USGS VHP GeoJSON (yellow/orange/red only)."""
    try:
        async with session.get(USGS_VOLCANO_GEOJSON) as resp:
            if resp.status != 200:
                logger.warning("USGS volcano API HTTP %s", resp.status)
                return []
            data = await resp.json(content_type=None)
    except Exception:
        logger.exception("USGS volcano fetch failed")
        return []

    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        return []

    elevated = {"yellow", "orange", "red", "y", "o", "r"}
    events: list[dict] = []
    for feature in features:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        color = (props.get("colorCode") or props.get("color") or "").lower()
        alert_level = (props.get("alertLevel") or "").lower()
        # Only elevated monitors — full US catalog is too noisy for the globe
        if color not in elevated and alert_level not in {
            "advisory",
            "watch",
            "warning",
        }:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        code = props.get("volcanoCd") or props.get("vnum") or props.get("id") or len(events)
        name = props.get("volcanoName") or props.get("name") or "Volcano"
        alert = alert_level or color or None
        mag = float(ALERT_ORDINAL.get(color or "", 2)) if color else 2.0
        events.append(
            _point_event(
                event_id=f"usgs-volcano-{code}",
                event_type="volcano",
                lon=lon,
                lat=lat,
                time=_utcnow_iso(),
                title=f"{name} ({(color or 'elevated').upper()})",
                magnitude=mag,
                alert_level=alert,
                source_url=props.get("volcanoUrl")
                or props.get("url")
                or "https://www.usgs.gov/programs/VHP",
                extra={"color_code": color, "alert_level": props.get("alertLevel")},
            )
        )
    return events


async def _safe_call(label: str, coro) -> tuple[str, list[dict], str]:
    try:
        result = await coro
        if isinstance(result, tuple):
            events, status = result
            return label, events, status
        return label, result, "ok"
    except Exception as exc:
        logger.exception("%s scrape failed", label)
        return label, [], f"error:{type(exc).__name__}"


async def update_cache() -> dict[str, Any]:
    """Full update cycle: fetch all sources, normalise, write gzipped cache."""
    timeout = _session_timeout()
    async with aiohttp.ClientSession(timeout=timeout, headers=_headers()) as session:
        results = await asyncio.gather(
            _safe_call("usgs", fetch_usgs(session)),
            _safe_call("firms", fetch_nasa_firms(session)),
            _safe_call("gdacs_tc", fetch_gdacs(session, "TC")),
            _safe_call("gdacs_vo", fetch_gdacs(session, "VO")),
            _safe_call("gdacs_ts", fetch_gdacs(session, "TS")),
            _safe_call("usgs_volcano", fetch_usgs_volcanoes(session)),
        )

    sources: dict[str, str] = {}
    all_events: list[dict] = []
    seen_ids: set[str] = set()

    for label, events, status in results:
        sources[label] = status
        for ev in events:
            eid = ev.get("id")
            if eid in seen_ids:
                continue
            seen_ids.add(eid)
            all_events.append(ev)

    # Aggregate GDACS status
    gdacs_parts = [sources.get(k, "ok") for k in ("gdacs_tc", "gdacs_vo", "gdacs_ts")]
    sources["gdacs"] = (
        "ok" if all(s == "ok" for s in gdacs_parts) else ";".join(
            f"{k}={sources.get(k)}" for k in ("gdacs_tc", "gdacs_vo", "gdacs_ts")
        )
    )

    payload = {
        "last_updated": _utcnow_iso(),
        "sources": {
            "usgs": sources.get("usgs", "unknown"),
            "firms": sources.get("firms", "unknown"),
            "gdacs": sources.get("gdacs", "unknown"),
            "usgs_volcano": sources.get("usgs_volcano", "unknown"),
        },
        "events": all_events,
    }

    cache_path = Path(settings.CACHE_PATH)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
    with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    tmp_path.replace(cache_path)

    logger.info(
        "Cache updated with %d events (sources=%s)",
        len(all_events),
        payload["sources"],
    )
    return payload


async def scraper_loop() -> None:
    """Run update_cache forever every SCRAPE_INTERVAL_SECONDS."""
    while True:
        try:
            await update_cache()
        except Exception:
            logger.exception("Scraper loop failed")
        await asyncio.sleep(SCRAPE_INTERVAL_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    import os

    if not os.getenv("CACHE_PATH"):
        local = Path(__file__).resolve().parent.parent / "data" / "live_disasters.json.gz"
        settings.CACHE_PATH = str(local)

    asyncio.run(update_cache())

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


def _firms_csv_url(source: str, area: str) -> str:
    return (
        "https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{NASA_FIRMS_MAP_KEY}/{source}/{area}/{NASA_FIRMS_DAY_RANGE}"
    )


def _parse_firms_csv(body: str, source: str) -> list[dict]:
    if not body or body.strip().lower().startswith("<!doctype") or "Invalid" in body[:80]:
        return []
    reader = csv.DictReader(io.StringIO(body))
    events: list[dict] = []
    for row in reader:
        row_l = {
            (k or "").strip().lstrip(chr(0xFEFF)).lower(): v for k, v in row.items()
        }
        try:
            lat = float(row_l.get("latitude") or row_l.get("lat"))
            lon = float(row_l.get("longitude") or row_l.get("lon"))
        except (TypeError, ValueError):
            continue
        conf = str(row_l.get("confidence") or "").strip().lower()
        if conf in {"l", "low"}:
            continue
        if conf.isdigit() and int(conf) < 30:
            continue
        brightness = None
        for key in ("bright_ti4", "brightness", "bright_t31"):
            if row_l.get(key):
                try:
                    brightness = float(row_l[key])
                    break
                except ValueError:
                    pass
        frp = None
        if row_l.get("frp"):
            try:
                frp = float(row_l["frp"])
            except ValueError:
                pass
        acq_date = row_l.get("acq_date") or ""
        acq_time = (row_l.get("acq_time") or "0000").zfill(4)
        try:
            dt = datetime.strptime(f"{acq_date}{acq_time}", "%Y-%m-%d%H%M").replace(
                tzinfo=timezone.utc
            )
            time_iso = dt.isoformat()
        except ValueError:
            time_iso = _utcnow_iso()
        sat = row_l.get("satellite") or source
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
                extra={"confidence": conf, "satellite": sat, "source": source},
            )
        )
    return events


def _firms_na_areas() -> list[tuple[str, str]]:
    """Priority North America boxes — fetched BEFORE world so USA/Canada aren't starved."""
    return [
        ("conus", "-125,24,-66,50"),
        ("canada", "-141,41,-52,84"),
        ("alaska", "-170,54,-129,72"),
        ("mexico", "-118,14,-86,33"),
    ]


async def fetch_nasa_firms(session: aiohttp.ClientSession) -> tuple[list[dict], str]:
    """NA-first FIRMS: regional US/Canada pulls, then world fill."""
    import os

    if not NASA_FIRMS_MAP_KEY:
        logger.warning("NASA_FIRMS_MAP_KEY not set - skipping wildfire scrape")
        return [], "skipped_no_key"

    primary = NASA_FIRMS_SOURCE or "VIIRS_SNPP_NRT"
    sources = [primary]
    for extra in ("VIIRS_NOAA20_NRT", "LANDSAT_NRT"):
        if extra not in sources:
            sources.append(extra)
    env_sources = os.getenv("NASA_FIRMS_SOURCES", "").strip()
    if env_sources:
        sources = [s.strip() for s in env_sources.split(",") if s.strip()]

    merged: list[dict] = []
    ok = 0
    # 1) North America first
    for source in sources:
        for label, area in _firms_na_areas():
            if source == "LANDSAT_NRT" and label not in {"conus", "canada", "alaska"}:
                continue
            try:
                async with session.get(_firms_csv_url(source, area)) as resp:
                    body = await resp.text()
                    if resp.status != 200:
                        continue
                    batch = _parse_firms_csv(body, source)
                    merged.extend(batch)
                    ok += 1
                    logger.info("FIRMS NA %s %s -> %s", source, label, len(batch))
            except Exception as exc:  # noqa: BLE001
                logger.warning("FIRMS NA fail %s %s: %s", source, label, exc)

    # 2) World fill (remaining seat budget after NA kept)
    try:
        async with session.get(_firms_csv_url(primary, "world")) as resp:
            body = await resp.text()
            if resp.status == 200:
                batch = _parse_firms_csv(body, primary)
                merged.extend(batch)
                ok += 1
                logger.info("FIRMS world %s -> %s", primary, len(batch))
    except Exception as exc:  # noqa: BLE001
        logger.warning("FIRMS world fail: %s", exc)

    if not ok:
        return [], "error_no_firms"

    # Dedupe + NA-weighted keep
    best: dict[tuple[int, int], dict] = {}
    for e in merged:
        lon, lat = e["geometry"]["coordinates"][:2]
        key = (int(round(lat * 20)), int(round(lon * 20)))
        frp = float(e["properties"].get("fire_radiance") or e["properties"].get("magnitude") or 0)
        prev = best.get(key)
        prev_frp = 0.0
        if prev:
            prev_frp = float(
                prev["properties"].get("fire_radiance")
                or prev["properties"].get("magnitude")
                or 0
            )
        if not prev or frp >= prev_frp:
            best[key] = e
    uniq = list(best.values())

    def frp_of(e: dict) -> float:
        return float(e["properties"].get("fire_radiance") or e["properties"].get("magnitude") or 0)

    def is_na(e: dict) -> bool:
        lon, lat = e["geometry"]["coordinates"][:2]
        return 14 <= lat <= 84 and -170 <= lon <= -52

    na = sorted([e for e in uniq if is_na(e)], key=frp_of, reverse=True)
    other = sorted([e for e in uniq if not is_na(e)], key=frp_of, reverse=True)
    limit = FIRMS_MAX_POINTS
    # Keep ~60% seats for North America when available
    na_quota = min(len(na), max(int(limit * 0.60), 2500))
    picked = na[:na_quota]
    picked.extend(other[: max(0, limit - len(picked))])
    logger.info("FIRMS selected %s (NA=%s other=%s)", len(picked), min(len(na), na_quota), len(picked) - min(len(na), na_quota))
    return picked, "ok"


async def fetch_cwfis_hotspots(session: aiohttp.ClientSession) -> tuple[list[dict], str]:
    """Free NRCan CWFIS last-24h hotspots (Canada + much of western US)."""
    url = (
        "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows"
        "?service=WFS&version=1.0.0&request=GetFeature"
        "&typeName=public:hotspots_last24hrs&outputFormat=json"
    )
    try:
        async with session.get(url) as resp:
            if resp.status != 200:
                return [], f"error_http_{resp.status}"
            data = await resp.json(content_type=None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("CWFIS fetch failed: %s", exc)
        return [], f"error_{exc.__class__.__name__}"

    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        return [], "error_bad_geojson"

    events: list[dict] = []
    for feat in features:
        props = (feat or {}).get("properties") or {}
        try:
            lat = float(props.get("lat"))
            lon = float(props.get("lon"))
        except (TypeError, ValueError):
            continue
        # Focus North America corridor
        if not (14 <= lat <= 84 and -170 <= lon <= -50):
            continue
        rep = props.get("rep_date") or _utcnow_iso()
        if isinstance(rep, str) and "T" not in rep:
            rep = rep.replace(" ", "T")
            if not rep.endswith("Z") and "+" not in rep:
                rep += "Z"
        sensor = props.get("sensor") or props.get("source") or "CWFIS"
        agency = props.get("agency") or ""
        hfi = props.get("hfi")
        try:
            mag = float(hfi) if hfi is not None else 1.0
        except (TypeError, ValueError):
            mag = 1.0
        eid = f"cwfis-{rep}-{lat:.3f}-{lon:.3f}-{sensor}"
        events.append(
            _point_event(
                event_id=eid,
                event_type="wildfire",
                lon=lon,
                lat=lat,
                time=str(rep),
                title=f"CWFIS hotspot ({agency or sensor})",
                magnitude=mag,
                fire_radiance=mag,
                source_url="https://cwfis.cfs.nrcan.gc.ca/",
                extra={
                    "source": "CWFIS",
                    "satellite": sensor,
                    "agency": agency,
                    "fwi": props.get("fwi"),
                },
            )
        )
        if len(events) >= FIRMS_MAX_POINTS:
            break
    logger.info("CWFIS hotspots -> %s NA points", len(events))
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


_CAT_ORD = {"TD": 1, "TS": 2, "STS": 2, "HU": 3, "TY": 3, "HR": 3, "MH": 4, "ST": 2}


def _stitch_tc_lines(features: list) -> tuple[list[list[float]], str | None]:
    """Stitch GDACS getgeometry LineStrings into a chronological track + trend."""
    segs: list[tuple[int, list[list[float]], str]] = []
    for feat in features or []:
        geom = (feat or {}).get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        coords = [
            [float(pt[0]), float(pt[1])]
            for pt in (geom.get("coordinates") or [])
            if isinstance(pt, (list, tuple)) and len(pt) >= 2
        ]
        if len(coords) < 2:
            continue
        props = (feat or {}).get("properties") or {}
        cls = str(props.get("Class") or "")
        idx = 0
        if "Line_Line_" in cls:
            try:
                idx = int(cls.rsplit("_", 1)[-1])
            except ValueError:
                idx = 0
        label = str(props.get("polygonlabel") or props.get("label") or "").upper()
        cat = "TS"
        for key in ("MH", "HU", "TY", "HR", "STS", "TS", "TD", "ST"):
            if key in label.split() or label == key:
                cat = key
                break
        segs.append((idx, coords, cat))

    if not segs:
        return [], None

    # Higher Line_Line_N is older; reverse → past → present → forecast
    segs.sort(key=lambda s: s[0], reverse=True)
    path: list[list[float]] = []
    cats: list[str] = []
    for _, coords, cat in segs:
        for pt in coords:
            if not path or path[-1] != pt:
                path.append(pt)
                cats.append(cat)

    trend = None
    if len(cats) >= 4:
        early = sum(_CAT_ORD.get(c, 2) for c in cats[: max(2, len(cats) // 4)]) / max(
            2, len(cats) // 4
        )
        late = sum(_CAT_ORD.get(c, 2) for c in cats[-max(2, len(cats) // 4) :]) / max(
            2, len(cats) // 4
        )
        if late - early >= 0.6:
            trend = "intensifying"
        elif early - late >= 0.6:
            trend = "weakening"
        else:
            trend = "steady"
    return path, trend


async def _fetch_gdacs_track(
    session: aiohttp.ClientSession, event_type: str, event_id: str
) -> tuple[list[list[float]], str | None]:
    """Track from GDACS getgeometry polygons API (geteventdata is Point-only)."""

    async def _load() -> tuple[list[list[float]], str | None]:
        async with session.get(
            GDACS_EVENT_URL, params={"eventtype": event_type, "eventid": event_id}
        ) as resp:
            if resp.status != 200:
                return [], None
            data = await resp.json(content_type=None)
        if not isinstance(data, dict):
            return [], None

        props = data.get("properties") or {}
        geom_url = ""
        url = props.get("url") or {}
        if isinstance(url, dict):
            geom_url = str(url.get("geometry") or "")
        if not geom_url:
            episode = props.get("episodeid") or 1
            geom_url = (
                "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry"
                f"?eventtype={event_type}&eventid={event_id}&episodeid={episode}"
            )

        async with session.get(geom_url) as resp:
            if resp.status != 200:
                return [], None
            geo = await resp.json(content_type=None)
        features = geo.get("features") if isinstance(geo, dict) else None
        if not isinstance(features, list):
            return [], None
        return _stitch_tc_lines(features)

    try:
        return await asyncio.wait_for(_load(), timeout=18)
    except Exception:
        logger.warning("GDACS track skipped for %s %s", event_type, event_id)
        return [], None


def _path_from_geometry(feature: dict) -> list[list[float]]:
    geom = feature.get("geometry") or {}
    if geom.get("type") == "LineString":
        return [
            [float(pt[0]), float(pt[1])]
            for pt in (geom.get("coordinates") or [])
            if len(pt) >= 2
        ]
    return []


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
    draft: list[dict] = []

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
            or len(draft)
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

        hurricane_path = _path_from_geometry(feature) if eventlist.upper() == "TC" else None

        draft.append(
            {
                "eid": str(eid_raw),
                "event": _point_event(
                    event_id=f"gdacs-{eventlist.lower()}-{eid_raw}",
                    event_type=mapped_type,
                    lon=lon,
                    lat=lat,
                    time=str(fromdate),
                    title=str(name)[:200],
                    magnitude=mag,
                    alert_level=alert,
                    source_url=str(url),
                    hurricane_path=hurricane_path or ([[lon, lat]] if eventlist.upper() == "TC" else None),
                    extra={"gdacs_eventlist": eventlist},
                ),
            }
        )

    # Enrich TC tracks concurrently (capped) when search geometry had no LineString
    if eventlist.upper() == "TC" and draft:
        need = [d for d in draft if len(d["event"]["properties"].get("hurricane_path") or []) <= 1]
        tracks = await asyncio.gather(
            *[_fetch_gdacs_track(session, "TC", d["eid"]) for d in need[:8]]
        )
        for d, track_meta in zip(need[:8], tracks):
            track, trend = track_meta
            if track and len(track) > 1:
                d["event"]["properties"]["hurricane_path"] = track
            if trend:
                extra = d["event"]["properties"].setdefault("extra", {})
                extra["intensity_trend"] = trend

    return [d["event"] for d in draft]


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
            _safe_call("cwfis", fetch_cwfis_hotspots(session)),
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
            "cwfis": sources.get("cwfis", "unknown"),
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

/**
 * DangerSphere — single-file UMD app (Three + Globe globals).
 * Cross-browser: Chrome, Firefox, Safari, Edge, mobile WebKit/Chromium.
 */
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  const FETCH_MS = 15000;
  const TEX = {
    day: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-day.jpg",
    night: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg",
    bump: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png",
    sky: "https://cdn.jsdelivr.net/npm/three-globe/example/img/night-sky.png",
  };
  const COLORS = {
    earthquake: "rgba(255, 77, 94, 0.95)",
    wildfire: "rgba(255, 138, 31, 0.95)",
    hurricane: "#2fe8ff",
    volcano: "rgba(255, 61, 206, 0.95)",
    tsunami: "rgba(77, 159, 255, 0.95)",
  };

  let globe = null;
  let liveCache = { events: [], last_updated: null };
  let cwfisEvents = [];
  let usgsRangeEvents = [];
  let cities = [];
  let rainViewerMaps = null;
  let radarTiles = [];
  let dayNightMaterial = null;
  let timeRange = "1d";

  function setError(msg) {
    const el = document.getElementById("meta-error");
    if (el) el.textContent = msg || "";
  }

  function timeoutSignal(ms) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
    const c = new AbortController();
    setTimeout(function () {
      c.abort();
    }, ms);
    return c.signal;
  }

  async function fetchJson(url, label, timeoutMs) {
    const resp = await fetch(url, {
      cache: "no-store",
      signal: timeoutSignal(timeoutMs || FETCH_MS),
    });
    if (!resp.ok) throw new Error(label + " HTTP " + resp.status);
    return resp.json();
  }

  function sunPosAt(dt) {
    dt = dt || Date.now();
    const d = new Date(dt);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const dayOfYear = (dt - start) / 864e5;
    const decl = 23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365.25);
    const hours =
      d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    let lng = 180 - hours * 15;
    while (lng < -180) lng += 360;
    while (lng > 180) lng -= 360;
    return [lng, decl];
  }

  function readTimeRange() {
    var el = document.querySelector('input[name="time-range"]:checked');
    timeRange = (el && el.value) || "1d";
    return timeRange;
  }

  function rangeHours() {
    if (timeRange === "7d") return 24 * 7;
    if (timeRange === "30d") return 24 * 30;
    return 36; // Today ≈ last 36h (quakes / storms)
  }

  function parseEventTime(e) {
    var p = e.properties || {};
    var candidates = [
      p.time,
      p.todate,
      (p.extra || {}).todate,
      (p.extra || {}).datemodified,
    ];
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var t = Date.parse(String(candidates[i]));
      if (!isNaN(t) && (best == null || t > best)) best = t;
    }
    return best;
  }

  function inTimeRange(e) {
    var t = parseEventTime(e);
    if (t == null) return e.type !== "hurricane";
    var ageH = (Date.now() - t) / 36e5;
    var limit = rangeHours();
    // FIRMS hotspots often land 24–48h behind "now". On "Today", accept the
    // current live-cache wildfire snapshot (vs feed last_updated) up to ~3 days.
    if (e.type === "wildfire" && timeRange === "1d") {
      limit = 72;
      var feedTs =
        liveCache && liveCache.last_updated
          ? Date.parse(liveCache.last_updated)
          : NaN;
      if (!isNaN(feedTs)) {
        var feedAgeH = (feedTs - t) / 36e5;
        if (feedAgeH >= -6 && feedAgeH <= 72 && ageH <= 96) return true;
      }
    }
    return ageH <= limit && ageH >= -6;
  }

  function readViewMode() {
    var el = document.querySelector('input[name="view-mode"]:checked');
    return (el && el.value) || "hazards";
  }

  function readLayers() {
    return {
      earthquake: document.getElementById("layer-earthquakes").checked,
      wildfire: document.getElementById("layer-wildfires").checked,
      hurricane: document.getElementById("layer-hurricanes").checked,
      volcano: document.getElementById("layer-volcanoes").checked,
      tsunami: document.getElementById("layer-tsunamis").checked,
      radar: readViewMode() === "weather",
      cities: document.getElementById("layer-cities").checked,
      wxClouds: !!(document.getElementById("wx-clouds") && document.getElementById("wx-clouds").checked),
      wxPrecip: !!(document.getElementById("wx-precip") && document.getElementById("wx-precip").checked),
    };
  }

  function mergedEvents() {
    var byId = {};
    function add(list) {
      (list || []).forEach(function (e) {
        if (!e || !e.id) return;
        byId[e.id] = e;
      });
    }
    add(liveCache.events);
    add(cwfisEvents);
    add(usgsRangeEvents);
    return Object.keys(byId).map(function (k) {
      return byId[k];
    });
  }

  function filterEvents(events, layers) {
    readTimeRange();
    return (events || []).filter(function (e) {
      if (layers[e.type] === false) return false;
      return inTimeRange(e);
    });
  }

  /** Tiny point backups only when HTML overlays are off; wildfires use HTML embers. */
  function toPoints(events, layers) {
    return [];
  }

  /** Hybrid fires: major hotspots only, equal seats per world grid cell. */
  var MAX_FIRE_HTML = 50;
  var MAX_FIRE_POINTS = 180;
  /** ~15° squares — coarser = fairer continent spread */
  var FIRE_GRID_DEG = 15;
  /** Cap per square so one blaze field can't carpet a region */
  var FIRE_PER_SQUARE = 1;
  /** FIRMS FRP (MW) cutoff for "major" — drop tiny agricultural/gas flares */
  var MIN_FIRE_FRP = 30;
  /** CWFIS HFI cutoff (raw units; HFI dwarfs FRP) */
  var MIN_CWFIS_HFI = 5000;
  /** Absolute max CWFIS markers merged in (NA supplement only) */
  var MAX_CWFIS_EVENTS = 10;
  /** Hard ceiling: North America share of displayed fires */
  var MAX_NA_SHARE = 0.18;
  var fireShown = 0;
  var fireTotal = 0;
  var fireHtmlShown = 0;
  var fireGridCells = 0;
  var radarTilesBound = null;
  var radarRefreshTimer = null;

  var LAYER_IDS = [
    "layer-earthquakes",
    "layer-wildfires",
    "layer-hurricanes",
    "layer-volcanoes",
    "layer-tsunamis",
    "layer-cities",
  ];

  function windCategory(kmh) {
    var w = Number(kmh) || 0;
    if (w >= 252) return "C5";
    if (w >= 209) return "C4";
    if (w >= 178) return "C3";
    if (w >= 154) return "C2";
    if (w >= 119) return "C1";
    if (w >= 63) return "TS";
    return "TD";
  }

  function fireRawIntensity(e) {
    var p = e.properties || {};
    var raw =
      p.fire_radiance != null
        ? Number(p.fire_radiance)
        : p.magnitude != null
          ? Number(p.magnitude)
          : 0;
    if (!isFinite(raw) || raw < 0) return 0;
    return raw;
  }

  function isCwfis(e) {
    return String(((e.properties || {}).extra || {}).source || "").toUpperCase() === "CWFIS";
  }

  /** Comparable intensity across FIRMS FRP vs CWFIS HFI (HFI is often huge). */
  function fireFrp(e) {
    var raw = fireRawIntensity(e);
    if (isCwfis(e)) {
      // Compress HFI into a FIRMS-like band so US/Canada doesn't win every ember
      return Math.min(120, Math.log10(1 + raw) * 28);
    }
    return raw;
  }

  function isMajorFire(e) {
    var raw = fireRawIntensity(e);
    if (isCwfis(e)) return raw >= MIN_CWFIS_HFI;
    return raw >= MIN_FIRE_FRP;
  }

  function fireGridKey(lat, lon) {
    return (
      Math.floor(lat / FIRE_GRID_DEG) + ":" + Math.floor(lon / FIRE_GRID_DEG)
    );
  }

  /** Soft world regions so sampling stays even when one belt has many majors. */
  function fireRegionKey(lat, lon) {
    if (lat >= 15 && lon >= -170 && lon <= -50) return "NA";
    if (lat < 15 && lon >= -90 && lon <= -30) return "SA";
    if (lon >= -20 && lon < 55) return lat >= 35 ? "EU" : "AF";
    if (lon >= 55 && lon < 100) return "WAS";
    if (lon >= 100 && lon < 150) return lat >= 0 ? "EAS" : "SEA";
    if (lon >= 150 || lon < -170) return "PAC";
    return "OT";
  }

  /** Stable shuffle so square iteration isn't biased by insert order (often NA-first). */
  function shuffleKeys(keys) {
    var a = keys.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var h = 0;
      var s = a[i];
      for (var c = 0; c < s.length; c++) h = (h * 31 + s.charCodeAt(c)) >>> 0;
      var j = h % (i + 1);
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  /**
   * Globally representative major-fire sample:
   * - Drop small hotspots first
   * - Equal seats per lat/lon square + soft region cap
   * - Embers round-robin across squares (not global max intensity)
   */
  function rankFires(events) {
    var fires = (events || []).filter(function (e) {
      return e.type === "wildfire" && isMajorFire(e);
    });
    fireTotal = fires.length;
    fireGridCells = 0;
    if (!fires.length) return [];

    var bySquare = {};
    fires.forEach(function (e) {
      var lon = e.geometry.coordinates[0];
      var lat = e.geometry.coordinates[1];
      var key = fireGridKey(lat, lon);
      if (!bySquare[key]) bySquare[key] = [];
      bySquare[key].push({
        e: e,
        frp: fireFrp(e),
        lat: lat,
        lon: lon,
        region: fireRegionKey(lat, lon),
      });
    });

    var squareKeys = shuffleKeys(Object.keys(bySquare));
    fireGridCells = squareKeys.length;
    squareKeys.forEach(function (k) {
      bySquare[k].sort(function (a, b) {
        // Prefer FIRMS over CWFIS in the same square, then higher intensity
        var ac = isCwfis(a.e) ? 1 : 0;
        var bc = isCwfis(b.e) ? 1 : 0;
        if (ac !== bc) return ac - bc;
        return b.frp - a.frp;
      });
    });

    var budget = MAX_FIRE_HTML + MAX_FIRE_POINTS;
    var perSquare = Math.max(
      1,
      Math.min(FIRE_PER_SQUARE, Math.floor(budget / Math.max(squareKeys.length, 1)))
    );
    // Soft cap so one continent can't take most of the budget when it has many cells
    var maxPerRegion = Math.max(6, Math.ceil(budget / 8));
    var maxNa = Math.max(4, Math.floor(budget * MAX_NA_SHARE));

    var cursors = {};
    squareKeys.forEach(function (k) {
      cursors[k] = 0;
    });
    var poolBySquare = {};
    squareKeys.forEach(function (k) {
      poolBySquare[k] = [];
    });
    var regionCounts = {};
    var seen = {};
    var totalPicked = 0;

    function takeFrom(key, n) {
      var list = bySquare[key] || [];
      var i = cursors[key] || 0;
      while (n > 0 && i < list.length && totalPicked < budget) {
        var item = list[i++];
        var id = item.e.id || item.lat + "," + item.lon;
        if (seen[id]) continue;
        var rc = regionCounts[item.region] || 0;
        if (rc >= maxPerRegion) continue;
        if (item.region === "NA" && rc >= maxNa) continue;
        seen[id] = true;
        regionCounts[item.region] = rc + 1;
        poolBySquare[key].push(item);
        totalPicked++;
        n--;
      }
      cursors[key] = i;
    }

    squareKeys.forEach(function (k) {
      takeFrom(k, perSquare);
    });

    var guard = 0;
    while (totalPicked < budget && guard < budget * 4) {
      var progressed = false;
      for (var si = 0; si < squareKeys.length; si++) {
        var before = totalPicked;
        takeFrom(squareKeys[si], 1);
        if (totalPicked > before) progressed = true;
        if (totalPicked >= budget) break;
      }
      if (!progressed) break;
      guard++;
    }

    // Embers: geographic round-robin (NOT global hottest — that favored CWFIS/USA)
    var embers = [];
    var sqIdx = {};
    squareKeys.forEach(function (k) {
      sqIdx[k] = 0;
    });
    while (embers.length < MAX_FIRE_HTML) {
      var got = false;
      for (var ei = 0; ei < squareKeys.length; ei++) {
        var sk = squareKeys[ei];
        var pile = poolBySquare[sk];
        var ix = sqIdx[sk] || 0;
        if (ix < pile.length && embers.length < MAX_FIRE_HTML) {
          embers.push(pile[ix]);
          sqIdx[sk] = ix + 1;
          got = true;
        }
      }
      if (!got) break;
    }

    var points = [];
    squareKeys.forEach(function (k) {
      var pile = poolBySquare[k];
      var start = sqIdx[k] || 0;
      for (var pi = start; pi < pile.length; pi++) points.push(pile[pi]);
    });

    return embers.concat(points);
  }

  function toFirePoints(ranked) {
    var rest = ranked.slice(MAX_FIRE_HTML, MAX_FIRE_HTML + MAX_FIRE_POINTS);
    return rest.map(function (item) {
      var e = item.e;
      var frp = item.frp;
      var hot = frp >= 40;
      var mid = frp >= 15;
      return {
        lat: e.geometry.coordinates[1],
        lng: e.geometry.coordinates[0],
        color: hot
          ? "rgba(255, 48, 0, 0.92)"
          : mid
            ? "rgba(255, 120, 20, 0.88)"
            : "rgba(255, 170, 40, 0.75)",
        altitude: 0.01,
        radius: 0.18 + Math.min(frp / 100, 0.4),
        type: "wildfire",
        title: e.properties.title || "Fire hotspot",
        time: e.properties.time,
        magnitude: frp,
        source_url: e.properties.source_url,
      };
    });
  }

  function toFireHtml(ranked) {
    var top = ranked.slice(0, MAX_FIRE_HTML);
    fireHtmlShown = top.length;
    return top.map(function (item) {
      var e = item.e;
      var frp = item.frp;
      return {
        lat: e.geometry.coordinates[1],
        lng: e.geometry.coordinates[0],
        type: "wildfire",
        title: e.properties.title || "Fire hotspot",
        time: e.properties.time,
        magnitude: frp,
        source_url: e.properties.source_url,
        size: 14 + Math.min(frp / 18, 22),
        kind: "fire",
        alertClass: frp >= 50 ? "fire-hot" : frp >= 20 ? "fire-mid" : "",
      };
    });
  }

  function setWeatherMode(on) {
    document.body.classList.toggle("radar-mode", on);
    document.body.classList.toggle("weather-mode", on);
    var haz = document.getElementById("panel-hazards");
    var wx = document.getElementById("panel-weather");
    if (haz) haz.hidden = !!on;
    if (wx) wx.hidden = !on;
  }

  function mercatorLat(y, n) {
    return (
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    );
  }

  function loadTileMaterial(url, opacity, grayscale) {
    var loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    return new Promise(function (resolve) {
      loader.load(
        url,
        function (tex) {
          if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          if (grayscale && tex.image) {
            try {
              var c = document.createElement("canvas");
              c.width = tex.image.width;
              c.height = tex.image.height;
              var ctx = c.getContext("2d");
              ctx.drawImage(tex.image, 0, 0);
              var img = ctx.getImageData(0, 0, c.width, c.height);
              var d = img.data;
              for (var i = 0; i < d.length; i += 4) {
                var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                // Boost clouds: brighten midtones, keep transparency-ish darks
                g = Math.min(255, g * 1.15);
                d[i] = d[i + 1] = d[i + 2] = g;
              }
              ctx.putImageData(img, 0, 0);
              tex.image = c;
              tex.needsUpdate = true;
            } catch (e) {
              /* cross-origin canvas may taint — keep color */
            }
          }
          resolve(
            new THREE.MeshBasicMaterial({
              map: tex,
              transparent: true,
              opacity: opacity,
              depthWrite: false,
              side: THREE.DoubleSide,
            })
          );
        },
        undefined,
        function () {
          resolve(null);
        }
      );
    });
  }

  function buildMercatorTiles(hostPathBuilder, z, opacity, altitude, grayscale) {
    var n = Math.pow(2, z);
    var pending = [];
    for (var x = 0; x < n; x++) {
      for (var y = 0; y < n; y++) {
        (function (x, y) {
          var latNorth = mercatorLat(y, n);
          var latSouth = mercatorLat(y + 1, n);
          var lngWest = (x / n) * 360 - 180;
          var width = 360 / n;
          var height = Math.max(latNorth - latSouth, 0.05);
          var url = hostPathBuilder(x, y, z);
          pending.push(
            loadTileMaterial(url, opacity, grayscale).then(function (material) {
              if (!material) return null;
              return {
                lat: (latNorth + latSouth) / 2,
                lng: lngWest,
                width: width,
                height: height,
                altitude: altitude,
                material: material,
              };
            })
          );
        })(x, y);
      }
    }
    return Promise.all(pending).then(function (tiles) {
      return tiles.filter(Boolean);
    });
  }

  function buildRadarTiles(host, framePath, z, colorScheme) {
    return buildMercatorTiles(
      function (x, y, z) {
        return (
          host +
          framePath +
          "/256/" +
          z +
          "/" +
          x +
          "/" +
          y +
          "/" +
          colorScheme +
          "/1_1.png"
        );
      },
      z,
      0.88,
      0.014,
      false
    );
  }

  function buildSatelliteTiles(host, framePath, z) {
    // RainViewer IR — color 0 is grayscale IR cloud field
    return buildMercatorTiles(
      function (x, y, z) {
        return host + framePath + "/256/" + z + "/" + x + "/" + y + "/0/0_0.png";
      },
      z,
      0.55,
      0.008,
      false
    );
  }

  function buildGibsCloudTiles(z) {
    // NASA GIBS true-color as soft cloud fluff when RainViewer IR is empty
    var d = new Date(Date.now() - 12 * 3600 * 1000);
    var ymd =
      d.getUTCFullYear() +
      "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getUTCDate()).padStart(2, "0");
    var layer = "MODIS_Terra_CorrectedReflectance_TrueColor";
    return buildMercatorTiles(
      function (x, y, z) {
        return (
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
          layer +
          "/default/" +
          ymd +
          "/GoogleMapsCompatible_Level9/" +
          z +
          "/" +
          y +
          "/" +
          x +
          ".jpg"
        );
      },
      z,
      0.42,
      0.007,
      true
    );
  }

  function stopRadarLoop() {
    if (radarTimer) {
      clearInterval(radarTimer);
      radarTimer = null;
    }
    if (radarRefreshTimer) {
      clearInterval(radarRefreshTimer);
      radarRefreshTimer = null;
    }
    radarTilesBound = null;
  }

  // Animation loop removed — rebuilding tilesData every tick caused constant flicker
  var radarTimer = null;
  function setRadarTilesOnce(tiles) {
    radarTiles = tiles || [];
    if (!globe) return;
    if (radarTilesBound === radarTiles) return;
    globe.tilesData(radarTiles);
    radarTilesBound = radarTiles;
  }

  function toHtmlHazards(events, layers) {
    return events
      .filter(function (e) {
        if (e.type === "earthquake") return layers.earthquake;
        if (e.type === "volcano") return layers.volcano;
        if (e.type === "tsunami") return layers.tsunami;
        if (e.type === "hurricane") return layers.hurricane;
        return false;
      })
      .map(function (e) {
        var lon = e.geometry.coordinates[0];
        var lat = e.geometry.coordinates[1];
        var mag = e.properties.magnitude != null ? e.properties.magnitude : 4;
        var alert = (e.properties.alert_level || "").toLowerCase();
        var extra = e.properties.extra || {};
        var size = 18;
        var kind = "quake";
        var alertClass = "";
        var category = "";
        var trend = extra.intensity_trend || null;

        if (e.type === "earthquake") {
          size = 14 + Math.pow(Math.max(mag, 1), 1.35) * 4;
          kind = "quake";
        } else if (e.type === "tsunami") {
          size = 36 + (mag || 2) * 6;
          kind = "tsunami";
        } else if (e.type === "volcano") {
          kind = "volcano";
          var volRank = {
            green: 1,
            advisory: 2,
            yellow: 2,
            watch: 3,
            orange: 4,
            red: 5,
          };
          var vr = volRank[alert] || (mag >= 3 ? 4 : mag >= 2 ? 3 : 2);
          size = 16 + vr * 7;
          alertClass = "alert-" + (alert || "advisory");
        } else if (e.type === "hurricane") {
          kind = "storm";
          var wind = mag || 50;
          size = 20 + Math.min(Math.max(wind, 40) / 4.5, 72);
          alertClass = "alert-" + (alert || "green");
          category = windCategory(wind);
        }

        var path = e.properties.hurricane_path || [];
        var moving = path.length >= 2;
        var bearing = null;
        if (moving) {
          var i0 = Math.max(0, path.length - 3);
          var a = path[i0];
          var b = path[path.length - 1];
          bearing = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
        }

        return {
          lat: lat,
          lng: lon,
          type: e.type,
          title: e.properties.title,
          time: e.properties.time,
          magnitude: mag,
          alert_level: alert,
          source_url: e.properties.source_url,
          depth_km: extra.depth_km,
          size: size,
          kind: kind,
          alertClass: alertClass,
          category: category,
          trend: trend,
          moving: moving,
          bearing: bearing,
          pathLen: path.length,
        };
      });
  }

  function toCityPins(cityList, onClick) {
    return (cityList || []).map(function (c) {
      return {
        lat: c.lat,
        lng: c.lon,
        isCity: true,
        name: c.name,
        country: c.country,
        city: c,
        onClick: onClick,
      };
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var toRad = function (d) {
      return (d * Math.PI) / 180;
    };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function nearbyEvents(events, lat, lon, radiusKm) {
    return (events || [])
      .map(function (e) {
        var elon = e.geometry.coordinates[0];
        var elat = e.geometry.coordinates[1];
        return { event: e, dist: haversineKm(lat, lon, elat, elon) };
      })
      .filter(function (x) {
        return x.dist <= radiusKm;
      })
      .sort(function (a, b) {
        return a.dist - b.dist;
      })
      .slice(0, 25);
  }

  function showDetail(item) {
    var hud = document.getElementById("detail-hud");
    document.getElementById("detail-title").textContent = item.title || "Event";
    document.getElementById("detail-type").textContent = (
      item.type || ""
    ).toUpperCase();

    var lines = [];
    if (item.time) lines.push("Time: " + item.time);

    if (item.type === "earthquake") {
      lines.push(
        "Magnitude: M" +
          (item.magnitude != null ? Number(item.magnitude).toFixed(1) : "?")
      );
      if (item.depth_km != null && item.depth_km !== "") {
        lines.push("Depth: " + Number(item.depth_km).toFixed(1) + " km");
      }
      lines.push("Ring size scales with magnitude. Open source for USGS status.");
    } else if (item.type === "volcano") {
      var alert = item.alert_level || "unknown";
      var state =
        alert === "red"
          ? "ACTIVE — eruption imminent / underway"
          : alert === "orange"
            ? "ELEVATED — heightened unrest / eruption possible"
            : alert === "watch" || alert === "yellow"
              ? "WATCH — elevated unrest"
              : "ADVISORY / MONITORING — not a major eruption alert";
      lines.push("Alert level: " + alert.toUpperCase());
      lines.push("Status: " + state);
      lines.push(
        "Triangle color: yellow=advisory · orange=elevated · red=active"
      );
    } else if (item.type === "hurricane") {
      var wind =
        item.magnitude != null ? Math.round(Number(item.magnitude)) : null;
      lines.push(
        "Max wind: " +
          (wind != null ? wind + " km/h (" + windCategory(wind) + ")" : "?")
      );
      lines.push("GDACS alert: " + (item.alert_level || "unknown").toUpperCase());
      if (item.trend) {
        lines.push(
          "Intensity trend: " +
            item.trend +
            (item.trend === "intensifying"
              ? " ↑"
              : item.trend === "weakening"
                ? " ↓"
                : " →")
        );
      }
      if (item.pathLen > 1) {
        lines.push(
          "Track: " +
            item.pathLen +
            " points — dashed path = motion; chevron = direction"
        );
      } else {
        lines.push(
          "Track: position only (apply backend track patch for full path)"
        );
      }
      lines.push("Disk size = wind speed. Color = GDACS alert.");
    } else if (item.type === "wildfire") {
      lines.push(
        "Radiance / FRP: " +
          (item.magnitude != null ? Number(item.magnitude).toFixed(1) : "?")
      );
    } else if (item.type === "tsunami") {
      lines.push("No active GDACS tsunami alerts in the current window.");
      if (item.magnitude != null) lines.push("Intensity proxy: " + item.magnitude);
    }

    document.getElementById("detail-time").textContent = lines[0] || "";
    document.getElementById("detail-mag").innerHTML = lines
      .slice(1)
      .map(function (l) {
        return "<div>" + l + "</div>";
      })
      .join("");

    var link = document.getElementById("detail-link");
    if (item.source_url) {
      link.href = item.source_url;
      link.hidden = false;
      link.textContent = "Open source report";
    } else {
      link.hidden = true;
    }
    hud.hidden = false;
  }

  function hideDetail() {
    document.getElementById("detail-hud").hidden = true;
  }

  function updateMeta(live) {
    var updated = document.getElementById("meta-updated");
    var counts = document.getElementById("meta-counts");
    var rangeLabel =
      timeRange === "7d" ? "week" : timeRange === "30d" ? "month" : "today";
    if (live && live.last_updated) {
      updated.textContent =
        "Cache " +
        new Date(live.last_updated).toLocaleString() +
        " · view: " +
        rangeLabel;
    } else {
      updated.textContent = "Awaiting first scrape… · view: " + rangeLabel;
    }
    var visible = filterEvents(mergedEvents(), readLayers());
    var tally = {};
    visible.forEach(function (e) {
      tally[e.type] = (tally[e.type] || 0) + 1;
    });
    var parts = Object.keys(tally).map(function (k) {
      if (k === "wildfire" && fireTotal > 0) {
        return (
          "wildfire: " +
          fireTotal +
          " → " +
          fireShown +
          " · " +
          fireGridCells +
          " cells"
        );
      }
      return k + ": " + tally[k];
    });
    if (!tally.tsunami) parts.push("tsunami: 0");
    if (!tally.wildfire) parts.push("wildfire: 0");
    if (cwfisEvents.length) parts.push("CWFIS+" + cwfisEvents.length);
    counts.textContent = parts.join(" · ");
  }

  function toPaths(events, layers) {
    if (!layers.hurricane) return [];
    return events
      .filter(function (e) {
        return (
          e.type === "hurricane" &&
          e.properties.hurricane_path &&
          e.properties.hurricane_path.length > 1
        );
      })
      .map(function (e) {
        var alert = (e.properties.alert_level || "green").toLowerCase();
        var col =
          alert === "red"
            ? "#ff4d5e"
            : alert === "orange"
              ? "#ff8a1f"
              : alert === "yellow"
                ? "#ffe566"
                : "#2fe8ff";
        var mag = e.properties.magnitude || 100;
        return {
          path: e.properties.hurricane_path.map(function (p) {
            return [p[1], p[0]];
          }),
          color: col,
          title: e.properties.title,
          // thicker stroke for stronger storms
          stroke: 1.2 + Math.min(mag / 120, 3.5),
        };
      });
  }

  function applyLayers() {
    if (!globe) return;
    var layers = readLayers();

    // Weather mode is a separate view (not a layer checkbox)
    if (layers.radar) {
      setWeatherMode(true);
      globe.pointsData([]);
      globe.pathsData([]);
      globe.htmlElementsData([]);
      setRadarTilesOnce(radarTiles);
      return;
    }

    setWeatherMode(false);
    radarTilesBound = null;
    var cityHtml = layers.cities
      ? toCityPins(cities, function (city) {
          focusCity(city);
        })
      : [];
    var visible = filterEvents(mergedEvents(), layers);
    var paths = toPaths(visible, layers);
    var rankedFires = layers.wildfire ? rankFires(visible) : [];
    if (!layers.wildfire) {
      fireTotal = 0;
      fireShown = 0;
      fireHtmlShown = 0;
    }
    var firePts = layers.wildfire ? toFirePoints(rankedFires) : [];
    var fireHtml = layers.wildfire ? toFireHtml(rankedFires) : [];
    fireShown = fireHtml.length + firePts.length;
    var htmlHaz = toHtmlHazards(visible, layers);

    globe.pointsData(firePts);
    globe.pathsData(paths);
    globe.htmlElementsData(htmlHaz.concat(fireHtml).concat(cityHtml));
    globe.tilesData([]);
    if (liveCache && liveCache.events) updateMeta(liveCache);
  }

  function focusCity(city) {
    if (globe) {
      globe.pointOfView({ lat: city.lat, lng: city.lon, altitude: 1.6 }, 1000);
    }
    openInsights(city);
  }

  function closeInsights() {
    var panel = document.getElementById("insights-panel");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("insights-open");
  }

  function drawSeries(canvas, seriesA, seriesB, labelA, labelB, colorA, colorB) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var pad = { t: 16, r: 12, b: 24, l: 36 };
    var plotW = w - pad.l - pad.r;
    var plotH = h - pad.t - pad.b;
    var vals = seriesA.concat(seriesB).filter(function (v) {
      return v != null && !isNaN(v);
    });
    if (!vals.length) {
      ctx.fillStyle = "#6a8a96";
      ctx.font = "12px Share Tech Mono, monospace";
      ctx.fillText("No data", pad.l, h / 2);
      return;
    }
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var span = max - min || 1;
    ctx.strokeStyle = "rgba(47,232,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.lineTo(w - pad.r, h - pad.b);
    ctx.stroke();
    function plot(series, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var started = false;
      series.forEach(function (v, i) {
        if (v == null) return;
        var x = pad.l + (i / Math.max(series.length - 1, 1)) * plotW;
        var y = pad.t + (1 - (v - min) / span) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    plot(seriesA, colorA);
    plot(seriesB, colorB);
    ctx.fillStyle = "#6a8a96";
    ctx.font = "11px Share Tech Mono, monospace";
    ctx.fillText(max.toFixed(1), 4, pad.t + 8);
    ctx.fillText(min.toFixed(1), 4, h - pad.b);
    ctx.fillStyle = colorA;
    ctx.fillText(labelA, pad.l, h - 6);
    ctx.fillStyle = colorB;
    ctx.fillText(labelB, pad.l + 90, h - 6);
  }

  async function openInsights(city) {
    var panel = document.getElementById("insights-panel");
    var title = document.getElementById("insights-title");
    var sub = document.getElementById("insights-subtitle");
    var summariesEl = document.getElementById("insights-summaries");
    var nearbyEl = document.getElementById("nearby-events");

    title.textContent = city.name;
    sub.textContent =
      city.country +
      " · " +
      city.lat.toFixed(2) +
      "°, " +
      city.lon.toFixed(2) +
      "° · loading…";
    summariesEl.innerHTML = "<p>Fetching climate context…</p>";
    nearbyEl.innerHTML = "";
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("insights-open");

    var nearby = nearbyEvents(liveCache.events || [], city.lat, city.lon, 750);
    nearbyEl.innerHTML = nearby.length
      ? nearby
          .map(function (x) {
            return (
              "<li><span class=\"ev-type\">" +
              x.event.type +
              "</span> " +
              x.event.properties.title +
              " · " +
              x.dist.toFixed(0) +
              " km</li>"
            );
          })
          .join("")
      : "<li>No live hazards within 750 km.</li>";

    try {
      var data = await fetchJson(
        "/api/insights?city_id=" + encodeURIComponent(city.id),
        "insights"
      );
      sub.textContent =
        city.country +
        " · recent " +
        data.windows.recent.start +
        " → " +
        data.windows.recent.end;
      summariesEl.innerHTML = (data.summaries || [])
        .map(function (s) {
          return "<p>" + s + "</p>";
        })
        .join("");
      var rTemp = (data.recent && data.recent.daily && data.recent.daily.temperature_2m_mean) || [];
      var bTemp =
        (data.baseline && data.baseline.daily && data.baseline.daily.temperature_2m_mean) || [];
      var rPrecip =
        (data.recent && data.recent.daily && data.recent.daily.precipitation_sum) || [];
      var bPrecip =
        (data.baseline && data.baseline.daily && data.baseline.daily.precipitation_sum) || [];
      drawSeries(
        document.getElementById("temp-chart"),
        rTemp,
        bTemp,
        "Recent",
        "Prior year",
        "#2fe8ff",
        "rgba(255,61,206,0.7)"
      );
      drawSeries(
        document.getElementById("precip-chart"),
        rPrecip,
        bPrecip,
        "Precip recent",
        "Precip prior",
        "#ff8a1f",
        "rgba(77,159,255,0.7)"
      );
    } catch (err) {
      console.error(err);
      summariesEl.innerHTML =
        "<p>Could not load insights: " + err.message + "</p>";
    }
  }

  function wireCitySearch() {
    var input = document.getElementById("city-search");
    var list = document.getElementById("city-results");
    function render(matches) {
      if (!matches.length) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }
      list.hidden = false;
      list.innerHTML = matches
        .slice(0, 12)
        .map(function (c) {
          return (
            '<li tabindex="0" data-id="' +
            c.id +
            '">' +
            c.name +
            ", " +
            c.country +
            "</li>"
          );
        })
        .join("");
    }
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      if (!q) {
        render([]);
        return;
      }
      render(
        cities.filter(function (c) {
          return (
            c.name.toLowerCase().indexOf(q) !== -1 ||
            c.country.toLowerCase().indexOf(q) !== -1 ||
            c.id.indexOf(q) !== -1
          );
        })
      );
    });
    list.addEventListener("click", function (ev) {
      var li = ev.target.closest("li[data-id]");
      if (!li) return;
      var city = cities.find(function (c) {
        return c.id === li.dataset.id;
      });
      if (city) {
        input.value = city.name + ", " + city.country;
        list.hidden = true;
        focusCity(city);
      }
    });
  }

  var dayNightShader = {
    vertexShader:
      "varying vec3 vNormal; varying vec2 vUv; void main(){ vNormal=normalize(normalMatrix*normal); vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: [
      "#define PI 3.141592653589793",
      "uniform sampler2D dayTexture; uniform sampler2D nightTexture;",
      "uniform vec2 sunPosition; uniform vec2 globeRotation;",
      "varying vec3 vNormal; varying vec2 vUv;",
      "float toRad(float a){ return a*PI/180.0; }",
      "vec3 Polar2Cartesian(vec2 c){",
      "  float theta=toRad(90.0-c.x); float phi=toRad(90.0-c.y);",
      "  return vec3(sin(phi)*cos(theta), cos(phi), sin(phi)*sin(theta));",
      "}",
      "void main(){",
      "  float invLon=toRad(globeRotation.x); float invLat=-toRad(globeRotation.y);",
      "  mat3 rotX=mat3(1.,0.,0.,0.,cos(invLat),-sin(invLat),0.,sin(invLat),cos(invLat));",
      "  mat3 rotY=mat3(cos(invLon),0.,sin(invLon),0.,1.,0.,-sin(invLon),0.,cos(invLon));",
      "  vec3 sunDir=rotX*rotY*Polar2Cartesian(sunPosition);",
      "  float intensity=dot(normalize(vNormal), normalize(sunDir));",
      "  vec4 dayColor=texture2D(dayTexture, vUv);",
      "  vec4 nightColor=texture2D(nightTexture, vUv);",
      "  // Soften contrast: dim noon, lift night city-light side",
      "  dayColor.rgb *= 0.78;",
      "  // Brighter city lights on the night side",
      "  nightColor.rgb = nightColor.rgb * 2.15 + vec3(0.07);",
      "  float blend=smoothstep(-0.35, 0.4, intensity);",
      "  gl_FragColor=mix(nightColor, dayColor, blend);",
      "}",
    ].join("\n"),
  };

  function initGlobe() {
    if (typeof Globe === "undefined" || typeof THREE === "undefined") {
      setError("Globe libraries failed to load (CDN blocked?). Allow jsdelivr.");
      throw new Error("Globe/THREE missing");
    }

    var container = document.getElementById("globe-container");
    globe = Globe()(container)
      .backgroundImageUrl(TEX.sky)
      .globeImageUrl(TEX.day)
      .bumpImageUrl(TEX.bump)
      .showAtmosphere(true)
      .atmosphereColor("#2fe8ff")
      .atmosphereAltitude(0.18)
      .pointsData([])
      .pointLat("lat")
      .pointLng("lng")
      .pointColor("color")
      .pointAltitude("altitude")
      .pointRadius("radius")
      .pointsMerge(false)
      .pointsTransitionDuration(0)
      .pointLabel(function (d) {
        return d.type + ": " + d.title;
      })
      .onPointClick(function (d) {
        if (d) showDetail(d);
      })
      .pathsData([])
      .pathPoints("path")
      .pathPointLat(function (p) {
        return p[0];
      })
      .pathPointLng(function (p) {
        return p[1];
      })
      .pathColor("color")
      .pathStroke(function (d) {
        return d.stroke || 1.5;
      })
      .pathDashLength(0.4)
      .pathDashGap(0.15)
      .pathDashAnimateTime(0)
      .htmlElementsData([])
      .htmlLat("lat")
      .htmlLng("lng")
      .htmlAltitude(0.012)
      .htmlElement(function (d) {
        // Root has NO CSS transform — Globe.gl CSS2D owns positioning.
        var root = document.createElement("div");
        root.title = d.title || (d.name ? d.name + ", " + d.country : "");

        if (d.isCity) {
          root.className = "city-pin";
          root.style.pointerEvents = "auto";
          root.style.cursor = "pointer";
          root.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (typeof d.onClick === "function") d.onClick(d.city);
          });
          return root;
        }

        root.className =
          "hazard-root " +
          (d.kind || "quake") +
          (d.alertClass ? " " + d.alertClass : "");
        root.style.width = (d.size || 18) + "px";
        root.style.height = (d.size || 18) + "px";
        root.style.pointerEvents = "auto";
        root.style.cursor = "pointer";

        var fx = document.createElement("div");
        fx.className = "fx";
        if (d.kind === "fire") {
          fx.style.animationDelay = ((d.magnitude || 0) % 10) * 0.07 + "s";
        }
        root.appendChild(fx);

        // Magnitude / alert badge (skip fires — ember is the signal)
        var badge = document.createElement("div");
        badge.className = "hazard-badge";
        if (d.kind === "quake" && d.magnitude != null) {
          badge.textContent = "M" + Number(d.magnitude).toFixed(1);
        } else if (d.kind === "volcano") {
          var vAlert = d.alert_level || "adv";
          badge.textContent =
            vAlert === "red" || vAlert === "orange"
              ? "ACTIVE"
              : vAlert === "watch" || vAlert === "yellow"
                ? "WATCH"
                : "ADV";
          badge.classList.add("vol-" + (vAlert || "adv"));
        } else if (d.kind === "storm") {
          var parts = [];
          if (d.category) parts.push(d.category);
          if (d.magnitude != null) parts.push(Math.round(d.magnitude) + "km/h");
          if (d.trend === "intensifying") parts.push("↑");
          else if (d.trend === "weakening") parts.push("↓");
          badge.textContent = parts.join(" ") || (d.alert_level || "TC").toUpperCase();
          if (d.trend) badge.classList.add("trend-" + d.trend);
        }
        if (badge.textContent) root.appendChild(badge);

        // Motion chevron for storms with a track
        if (d.kind === "storm" && d.moving && d.bearing != null) {
          var arrow = document.createElement("div");
          arrow.className = "storm-dir";
          arrow.style.transform = "rotate(" + d.bearing + "deg)";
          root.appendChild(arrow);
        }

        root.addEventListener("click", function (ev) {
          ev.stopPropagation();
          showDetail(d);
        });
        return root;
      })
      .tilesData([])
      .tileLat("lat")
      .tileLng("lng")
      .tileWidth("width")
      .tileHeight("height")
      .tileAltitude(function (d) {
        return d.altitude != null ? d.altitude : 0.012;
      })
      .tileMaterial("material")
      .tileCurvatureResolution(4);

    var controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.28;
    controls.enableDamping = true;
    controls.enableZoom = true;

    var idleTimer;
    var IDLE_MS = 24000; // ~3× previous delay before auto-rotate resumes
    function bumpIdle() {
      clearTimeout(idleTimer);
      controls.autoRotate = false;
      idleTimer = setTimeout(function () {
        controls.autoRotate = true;
      }, IDLE_MS);
    }
    container.addEventListener("pointerdown", bumpIdle);
    container.addEventListener("wheel", bumpIdle, { passive: true });
    container.addEventListener("touchstart", bumpIdle, { passive: true });

    function resize() {
      globe.width(window.innerWidth);
      globe.height(window.innerHeight);
    }
    window.addEventListener("resize", resize);
    resize();

    // Day/night blend (city lights on dark side)
    var loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    Promise.all([
      new Promise(function (res, rej) {
        loader.load(TEX.day, res, undefined, rej);
      }),
      new Promise(function (res, rej) {
        loader.load(TEX.night, res, undefined, rej);
      }),
    ])
      .then(function (pair) {
        var dayTexture = pair[0];
        var nightTexture = pair[1];
        if (THREE.SRGBColorSpace) {
          dayTexture.colorSpace = THREE.SRGBColorSpace;
          nightTexture.colorSpace = THREE.SRGBColorSpace;
        }
        var sun = sunPosAt();
        dayNightMaterial = new THREE.ShaderMaterial({
          uniforms: {
            dayTexture: { value: dayTexture },
            nightTexture: { value: nightTexture },
            sunPosition: { value: new THREE.Vector2(sun[0], sun[1]) },
            globeRotation: { value: new THREE.Vector2() },
          },
          vertexShader: dayNightShader.vertexShader,
          fragmentShader: dayNightShader.fragmentShader,
        });
        globe.globeMaterial(dayNightMaterial);
        globe.onZoom(function (pov) {
          dayNightMaterial.uniforms.globeRotation.value.set(pov.lng, pov.lat);
        });
        (function tick() {
          if (dayNightMaterial) {
            var s = sunPosAt();
            dayNightMaterial.uniforms.sunPosition.value.set(s[0], s[1]);
          }
          requestAnimationFrame(tick);
        })();
      })
      .catch(function (err) {
        console.warn("Day/night textures failed; keeping day map", err);
      });
  }

  function countLiveNaFires() {
    var n = 0;
    var total = 0;
    ((liveCache && liveCache.events) || []).forEach(function (e) {
      if (!e || e.type !== "wildfire") return;
      total++;
      var lon = e.geometry.coordinates[0];
      var lat = e.geometry.coordinates[1];
      if (lat >= 15 && lon >= -170 && lon <= -50) n++;
    });
    return { na: n, total: total };
  }

  async function fetchCwfisFires() {
    // CWFIS is NA-only and high-volume. Use it ONLY as a thin supplement when
    // the Mint FIRMS cache has almost no North America — never as the main layer.
    var live = countLiveNaFires();
    if (live.total >= 150 && live.na >= 8) {
      cwfisEvents = [];
      return;
    }
    try {
      var data = await fetchJson(
        "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=public:hotspots_last24hrs&outputFormat=json",
        "CWFIS",
        45000
      );
      var feats = data.features || [];
      var candidates = [];
      for (var i = 0; i < feats.length; i++) {
        var p = feats[i].properties || {};
        var lat = Number(p.lat);
        var lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        if (!(14 <= lat && lat <= 84 && -170 <= lon && lon <= -50)) continue;
        var mag = Number(p.hfi);
        if (!isFinite(mag) || mag < MIN_CWFIS_HFI) continue;
        candidates.push({
          lat: lat,
          lon: lon,
          mag: mag,
          rep: p.rep_date || new Date().toISOString(),
          sensor: p.sensor || p.source || "CWFIS",
          agency: p.agency || "",
          key: fireGridKey(lat, lon),
        });
      }
      candidates.sort(function (a, b) {
        return b.mag - a.mag;
      });
      // At most one per grid square, then hard global cap
      var usedSquare = {};
      var out = [];
      for (var ci = 0; ci < candidates.length && out.length < MAX_CWFIS_EVENTS; ci++) {
        var row = candidates[ci];
        if (usedSquare[row.key]) continue;
        usedSquare[row.key] = true;
        out.push({
          id:
            "cwfis-" +
            row.rep +
            "-" +
            row.lat.toFixed(3) +
            "-" +
            row.lon.toFixed(3) +
            "-" +
            row.sensor,
          type: "wildfire",
          geometry: { type: "Point", coordinates: [row.lon, row.lat] },
          properties: {
            time: String(row.rep),
            title: "CWFIS hotspot (" + (row.agency || row.sensor) + ")",
            magnitude: row.mag,
            fire_radiance: row.mag,
            source_url: "https://cwfis.cfs.nrcan.gc.ca/",
            extra: {
              source: "CWFIS",
              satellite: row.sensor,
              agency: row.agency,
            },
          },
        });
      }
      cwfisEvents = out;
    } catch (err) {
      console.warn("CWFIS offline", err);
      cwfisEvents = [];
    }
  }

  async function fetchUsgsForRange() {
    readTimeRange();
    // Live cache already has ~1 day quakes; pull week/month when asked
    if (timeRange === "1d") {
      usgsRangeEvents = [];
      return;
    }
    var feed =
      timeRange === "30d"
        ? "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson"
        : "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson";
    try {
      var geo = await fetchJson(feed, "USGS " + timeRange);
      usgsRangeEvents = (geo.features || []).map(function (f) {
        var props = f.properties || {};
        var coords = (f.geometry && f.geometry.coordinates) || [];
        var timeIso = props.time
          ? new Date(props.time).toISOString()
          : new Date().toISOString();
        return {
          id: "usgs-" + (f.id || props.code || Math.random()),
          type: "earthquake",
          geometry: {
            type: "Point",
            coordinates: [coords[0], coords[1]],
          },
          properties: {
            time: timeIso,
            title: props.title || "Earthquake",
            magnitude: props.mag,
            source_url: props.url || "",
            extra: { depth_km: coords[2] },
          },
        };
      });
    } catch (err) {
      console.warn("USGS range feed failed", err);
      usgsRangeEvents = [];
    }
  }

  async function refreshLive() {
    try {
      liveCache = await fetchJson("/data/live_disasters.json", "live data");
      await Promise.all([fetchCwfisFires(), fetchUsgsForRange()]);
      applyLayers();
      setError("");
    } catch (err) {
      console.error(err);
      setError("Live data error: " + err.message);
      document.getElementById("meta-updated").textContent = "Live data error";
    }
  }

  async function loadCities() {
    try {
      var data = await fetchJson("/api/cities", "cities");
      cities = data.cities || [];
      wireCitySearch();
      applyLayers();
    } catch (err) {
      console.error(err);
      setError("Cities offline: " + err.message);
    }
  }

  async function ensureRadar(on) {
    if (!on) {
      stopRadarLoop();
      radarTiles = [];
      radarTilesBound = null;
      if (globe) globe.tilesData([]);
      setWeatherMode(false);
      applyLayers();
      return;
    }
    setWeatherMode(true);
    document.getElementById("meta-updated").textContent = "Loading weather…";
    setError("");
    try {
      var wantClouds =
        !document.getElementById("wx-clouds") ||
        document.getElementById("wx-clouds").checked;
      var wantPrecip =
        !document.getElementById("wx-precip") ||
        document.getElementById("wx-precip").checked;

      rainViewerMaps = await fetchJson(
        "https://api.rainviewer.com/public/weather-maps.json",
        "RainViewer"
      );
      var host = rainViewerMaps.host || "";
      if (host && host.indexOf("http") !== 0) host = "https:" + host;

      var past = (rainViewerMaps.radar && rainViewerMaps.radar.past) || [];
      var nowcast = (rainViewerMaps.radar && rainViewerMaps.radar.nowcast) || [];
      var irFrames =
        (rainViewerMaps.satellite && rainViewerMaps.satellite.infrared) || [];
      var latestPrecip =
        (nowcast.length && nowcast[0]) ||
        (past.length && past[past.length - 1]) ||
        null;
      var latestIr = irFrames.length ? irFrames[irFrames.length - 1] : null;

      var cloudTiles = [];
      var precipTiles = [];
      var cloudSrc = "off";

      if (wantClouds) {
        if (latestIr) {
          cloudTiles = await buildSatelliteTiles(host, latestIr.path, 3);
          cloudSrc = "RainViewer IR";
        }
        if (!cloudTiles.length) {
          cloudTiles = await buildGibsCloudTiles(3);
          cloudSrc = cloudTiles.length ? "NASA GIBS (grayscale)" : "none";
        }
      }

      if (wantPrecip && latestPrecip) {
        precipTiles = await buildRadarTiles(host, latestPrecip.path, 3, 6);
      }

      var tiles = cloudTiles.concat(precipTiles);
      if (!tiles.length) {
        radarTiles = [];
        setError("Weather tiles failed — allow tilecache.rainviewer.com + gibs.earthdata.nasa.gov");
        applyLayers();
        return;
      }

      radarTilesBound = null;
      setRadarTilesOnce(tiles);
      setError("");
      var ageMin =
        latestPrecip && latestPrecip.time
          ? Math.max(0, Math.round((Date.now() / 1000 - latestPrecip.time) / 60))
          : "?";
      document.getElementById("meta-updated").textContent =
        "Weather · clouds " +
        cloudSrc +
        " · precip ~" +
        ageMin +
        " min · " +
        tiles.length +
        " tiles";
      applyLayers();

      if (radarRefreshTimer) clearInterval(radarRefreshTimer);
      radarRefreshTimer = setInterval(function () {
        if (readViewMode() !== "weather") {
          stopRadarLoop();
          return;
        }
        ensureRadar(true);
      }, 2 * 60 * 1000);
    } catch (err) {
      console.error(err);
      setError("Weather error: " + err.message);
      setWeatherMode(false);
    }
  }

  async function boot() {
    try {
      initGlobe();
    } catch (err) {
      console.error(err);
      return;
    }

    document.getElementById("detail-close").addEventListener("click", hideDetail);
    document.getElementById("btn-back-live").addEventListener("click", closeInsights);

    [
      "layer-earthquakes",
      "layer-wildfires",
      "layer-hurricanes",
      "layer-volcanoes",
      "layer-tsunamis",
      "layer-cities",
    ].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () {
        applyLayers();
      });
    });

    ["mode-hazards", "mode-weather"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        var mode = readViewMode();
        if (mode === "weather") ensureRadar(true);
        else ensureRadar(false);
      });
    });

    ["wx-clouds", "wx-precip"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        if (readViewMode() === "weather") ensureRadar(true);
      });
    });

    ["range-1d", "range-7d", "range-30d"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        readTimeRange();
        fetchUsgsForRange().then(function () {
          applyLayers();
        });
      });
    });

    await refreshLive();
    loadCities();
    setInterval(refreshLive, REFRESH_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refreshLive();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

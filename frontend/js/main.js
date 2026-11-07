/** DangerSphere frontend entry — resilient boot */

import { fetchCities, fetchLiveData, fetchRainViewerMaps } from "./api.js";
import {
  applyLayers,
  clearRadar,
  focusLatLng,
  initGlobe,
  setRadarFromRainViewer,
} from "./globe.js";
import { closeInsights, openInsights } from "./insights.js";
import {
  hideDetail,
  onLayerChange,
  readLayerState,
  updateMeta,
  wireCitySearch,
} from "./ui.js";

const REFRESH_MS = 5 * 60 * 1000;

let liveCache = { events: [], last_updated: null };
let cities = [];
let rainViewerMaps = null;

function render() {
  const layers = readLayerState();
  applyLayers({
    events: liveCache.events || [],
    cities,
    layers,
    onCityClick: (city) => {
      focusLatLng(city.lat, city.lon, 1.6);
      openInsights(city, liveCache.events || []);
    },
  });
}

async function refreshLive() {
  try {
    liveCache = await fetchLiveData();
    updateMeta(liveCache);
    render();
  } catch (err) {
    console.error("Live refresh failed", err);
    const el = document.getElementById("meta-updated");
    if (el) el.textContent = "Live data error — retrying…";
  }
}

async function loadCities() {
  try {
    cities = await fetchCities();
    wireCitySearch(cities, (city) => {
      focusLatLng(city.lat, city.lon, 1.6);
      openInsights(city, liveCache.events || []);
    });
    render();
  } catch (err) {
    console.error("Cities load failed", err);
    cities = [];
  }
}

async function ensureRadar(enabled) {
  if (!enabled) {
    clearRadar();
    render();
    return;
  }
  try {
    if (!rainViewerMaps) {
      rainViewerMaps = await fetchRainViewerMaps();
    }
    await setRadarFromRainViewer(rainViewerMaps);
    render();
  } catch (err) {
    console.error("Radar load failed", err);
  }
}

async function boot() {
  try {
    initGlobe(document.getElementById("globe-container"));
  } catch (err) {
    console.error("Globe init failed", err);
  }

  const closeBtn = document.getElementById("detail-close");
  const backBtn = document.getElementById("btn-back-live");
  if (closeBtn) closeBtn.addEventListener("click", hideDetail);
  if (backBtn) backBtn.addEventListener("click", closeInsights);

  onLayerChange(async () => {
    const layers = readLayerState();
    if (layers.radar) await ensureRadar(true);
    else {
      clearRadar();
      render();
    }
  });

  // Hazards must not wait on cities (cities was hanging the whole UI)
  await refreshLive();
  loadCities();

  setInterval(refreshLive, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshLive();
  });
}

boot().catch((err) => console.error("Boot failed", err));

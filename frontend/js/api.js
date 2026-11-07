/** API helpers for DangerSphere */

const FETCH_MS = 15000;

async function fetchJson(url, label) {
  const resp = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!resp.ok) throw new Error(`${label} HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchLiveData() {
  return fetchJson("/data/live_disasters.json", "live data");
}

export async function fetchCities() {
  const data = await fetchJson("/api/cities", "cities");
  return data.cities || [];
}

export async function fetchInsights(cityId) {
  const resp = await fetch(
    `/api/insights?city_id=${encodeURIComponent(cityId)}`,
    { signal: AbortSignal.timeout(FETCH_MS) }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`insights HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

export async function fetchHealth() {
  return fetchJson("/health", "health");
}

export async function fetchRainViewerMaps() {
  const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!resp.ok) throw new Error(`RainViewer HTTP ${resp.status}`);
  return resp.json();
}

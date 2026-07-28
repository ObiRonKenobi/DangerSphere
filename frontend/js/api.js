/** API helpers for DangerSphere */

export async function fetchLiveData() {
  const resp = await fetch("/data/live_disasters.json");
  if (!resp.ok) throw new Error(`live data HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchCities() {
  const resp = await fetch("/api/cities");
  if (!resp.ok) throw new Error(`cities HTTP ${resp.status}`);
  const data = await resp.json();
  return data.cities || [];
}

export async function fetchInsights(cityId) {
  const resp = await fetch(`/api/insights?city_id=${encodeURIComponent(cityId)}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`insights HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

export async function fetchHealth() {
  const resp = await fetch("/health");
  if (!resp.ok) throw new Error(`health HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchRainViewerMaps() {
  const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json");
  if (!resp.ok) throw new Error(`RainViewer HTTP ${resp.status}`);
  return resp.json();
}

/** HUD / detail / city search UI */

export function showDetail(item) {
  const hud = document.getElementById("detail-hud");
  document.getElementById("detail-title").textContent = item.title || "Event";
  document.getElementById("detail-type").textContent = item.type || "";
  document.getElementById("detail-time").textContent = item.time
    ? `Time: ${item.time}`
    : "";
  document.getElementById("detail-mag").textContent =
    item.magnitude != null ? `Magnitude / intensity: ${item.magnitude}` : "";
  const link = document.getElementById("detail-link");
  if (item.source_url) {
    link.href = item.source_url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  hud.hidden = false;
}

export function hideDetail() {
  document.getElementById("detail-hud").hidden = true;
}

export function updateMeta(live) {
  const updated = document.getElementById("meta-updated");
  const counts = document.getElementById("meta-counts");
  if (live?.last_updated) {
    updated.textContent = `Updated ${new Date(live.last_updated).toLocaleString()}`;
  } else {
    updated.textContent = "Awaiting first scrape…";
  }
  const tally = {};
  for (const e of live?.events || []) {
    tally[e.type] = (tally[e.type] || 0) + 1;
  }
  counts.textContent = Object.entries(tally)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

export function wireCitySearch(cities, onSelect) {
  const input = document.getElementById("city-search");
  const list = document.getElementById("city-results");

  function render(matches) {
    if (!matches.length) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.hidden = false;
    list.innerHTML = matches
      .slice(0, 12)
      .map(
        (c) =>
          `<li tabindex="0" data-id="${c.id}">${c.name}, ${c.country}</li>`
      )
      .join("");
  }

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      render([]);
      return;
    }
    render(
      cities.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.country.toLowerCase().includes(q) ||
          c.id.includes(q)
      )
    );
  });

  list.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-id]");
    if (!li) return;
    const city = cities.find((c) => c.id === li.dataset.id);
    if (city) {
      input.value = `${city.name}, ${city.country}`;
      list.hidden = true;
      onSelect(city);
    }
  });
}

export function readLayerState() {
  return {
    earthquake: document.getElementById("layer-earthquakes").checked,
    wildfire: document.getElementById("layer-wildfires").checked,
    hurricane: document.getElementById("layer-hurricanes").checked,
    volcano: document.getElementById("layer-volcanoes").checked,
    tsunami: document.getElementById("layer-tsunamis").checked,
    radar: document.getElementById("layer-radar").checked,
    cities: document.getElementById("layer-cities").checked,
  };
}

export function onLayerChange(handler) {
  [
    "layer-earthquakes",
    "layer-wildfires",
    "layer-hurricanes",
    "layer-volcanoes",
    "layer-tsunamis",
    "layer-radar",
    "layer-cities",
  ].forEach((id) => {
    document.getElementById(id).addEventListener("change", handler);
  });
}

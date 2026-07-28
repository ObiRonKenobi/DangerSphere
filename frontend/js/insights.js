/** City insights panel — charts + nearby hazards */

import { fetchInsights } from "./api.js";
import { nearbyEvents } from "./layers.js";

function drawSeries(canvas, seriesA, seriesB, labelA, labelB, colorA, colorB) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { t: 16, r: 12, b: 24, l: 36 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const vals = [...seriesA, ...seriesB].filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) {
    ctx.fillStyle = "#6a8a96";
    ctx.font = "12px Share Tech Mono, monospace";
    ctx.fillText("No data", pad.l, h / 2);
    return;
  }

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;

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
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const x = pad.l + (i / Math.max(series.length - 1, 1)) * plotW;
      const y = pad.t + (1 - (v - min) / span) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
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

export function closeInsights() {
  const panel = document.getElementById("insights-panel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("insights-open");
}

export async function openInsights(city, liveEvents) {
  const panel = document.getElementById("insights-panel");
  const title = document.getElementById("insights-title");
  const sub = document.getElementById("insights-subtitle");
  const summariesEl = document.getElementById("insights-summaries");
  const nearbyEl = document.getElementById("nearby-events");

  title.textContent = city.name;
  sub.textContent = `${city.country} · ${city.lat.toFixed(2)}°, ${city.lon.toFixed(2)}° · loading…`;
  summariesEl.innerHTML = "<p>Fetching climate context…</p>";
  nearbyEl.innerHTML = "";

  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  document.body.classList.add("insights-open");

  const nearby = nearbyEvents(liveEvents, city.lat, city.lon, 750);
  nearbyEl.innerHTML = nearby.length
    ? nearby
        .map(
          ({ event, dist }) =>
            `<li><span class="ev-type">${event.type}</span> ${event.properties.title} · ${dist.toFixed(0)} km</li>`
        )
        .join("")
    : "<li>No live hazards within 750 km.</li>";

  try {
    const data = await fetchInsights(city.id);
    sub.textContent = `${city.country} · recent ${data.windows.recent.start} → ${data.windows.recent.end}`;
    summariesEl.innerHTML = (data.summaries || [])
      .map((s) => `<p>${s}</p>`)
      .join("");

    const rTemp = data.recent?.daily?.temperature_2m_mean || [];
    const bTemp = data.baseline?.daily?.temperature_2m_mean || [];
    const rPrecip = data.recent?.daily?.precipitation_sum || [];
    const bPrecip = data.baseline?.daily?.precipitation_sum || [];

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
    summariesEl.innerHTML = `<p>Could not load insights: ${err.message}</p>`;
  }
}

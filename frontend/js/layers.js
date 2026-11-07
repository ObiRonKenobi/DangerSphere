/** Layer mapping helpers for Globe.gl */

export const LAYER_COLORS = {
  earthquake: "rgba(255, 77, 94, 0.95)",
  wildfire: "rgba(255, 138, 31, 0.9)",
  hurricane: "#2fe8ff",
  volcano: "rgba(255, 61, 206, 0.95)",
  tsunami: "rgba(77, 159, 255, 0.95)",
};

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function filterEvents(events, layers) {
  return (events || []).filter((e) => layers[e.type] !== false);
}

/**
 * Point markers for all enabled hazard types (reliable WebGL points).
 * layers: optional; if omitted, include fire + hurricane only (legacy).
 */
export function toPointMarkers(events, layers = null) {
  return events
    .filter((e) => {
      if (!layers) {
        return e.type === "wildfire" || e.type === "hurricane";
      }
      if (e.type === "wildfire") return layers.wildfire;
      if (e.type === "hurricane") return layers.hurricane;
      if (e.type === "earthquake") return layers.earthquake;
      if (e.type === "volcano") return layers.volcano;
      if (e.type === "tsunami") return layers.tsunami;
      return false;
    })
    .map((e) => {
      const [lon, lat] = e.geometry.coordinates;
      const mag = e.properties.magnitude ?? e.properties.fire_radiance ?? 5;
      let radius = 0.2;
      let altitude = 0.02;
      if (e.type === "wildfire") {
        radius = 0.1 + Math.min(mag / 80, 0.4);
        altitude = 0.012;
      } else if (e.type === "earthquake") {
        radius = 0.18 + Math.min((mag || 4) / 25, 0.55);
        altitude = 0.025;
      } else if (e.type === "volcano") {
        radius = 0.28;
        altitude = 0.03;
      } else if (e.type === "tsunami") {
        radius = 0.35;
        altitude = 0.02;
      } else if (e.type === "hurricane") {
        radius = 0.3;
        altitude = 0.025;
      }
      return {
        lat,
        lng: lon,
        type: e.type,
        title: e.properties.title,
        time: e.properties.time,
        magnitude: mag,
        source_url: e.properties.source_url,
        radius,
        altitude,
        color: LAYER_COLORS[e.type] || "#fff",
        event: e,
      };
    });
}

export function toHtmlHazards(events) {
  return events
    .filter((e) => ["earthquake", "volcano", "tsunami"].includes(e.type))
    .map((e) => {
      const [lon, lat] = e.geometry.coordinates;
      const mag = e.properties.magnitude ?? 4;
      let size = 18;
      let cls = "hazard-ring";
      if (e.type === "earthquake") {
        size = 16 + mag * 6;
        cls = "hazard-ring quake-ring";
      } else if (e.type === "tsunami") {
        size = 28 + (mag || 2) * 4;
        cls = "hazard-ring tsunami-ring";
      } else if (e.type === "volcano") {
        cls = "volcano-marker";
        size = 14;
      }
      return {
        lat,
        lng: lon,
        type: e.type,
        title: e.properties.title,
        time: e.properties.time,
        magnitude: mag,
        source_url: e.properties.source_url,
        size,
        cls,
        event: e,
      };
    });
}

export function toHurricanePaths(events) {
  return events
    .filter((e) => e.type === "hurricane" && e.properties.hurricane_path?.length)
    .map((e) => ({
      path: e.properties.hurricane_path.map(([lon, lat]) => [lat, lon]),
      color: LAYER_COLORS.hurricane,
      title: e.properties.title,
      event: e,
    }));
}

export function toCityMarkers(cities) {
  return (cities || []).map((c) => ({
    lat: c.lat,
    lng: c.lon,
    id: c.id,
    name: c.name,
    country: c.country,
    city: c,
  }));
}

export function nearbyEvents(events, lat, lon, radiusKm = 500) {
  return (events || [])
    .map((e) => {
      const [elon, elat] = e.geometry.coordinates;
      const dist = haversineKm(lat, lon, elat, elon);
      return { event: e, dist };
    })
    .filter((x) => x.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 25);
}

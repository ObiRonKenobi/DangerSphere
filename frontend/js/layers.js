/** Layer mapping helpers for Globe.gl */

export const LAYER_COLORS = {
  earthquake: "rgba(255, 77, 94, 0.9)",
  wildfire: "rgba(255, 138, 31, 0.85)",
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

export function toPointMarkers(events) {
  return events
    .filter((e) => e.type === "wildfire" || e.type === "hurricane")
    .map((e) => {
      const [lon, lat] = e.geometry.coordinates;
      const mag = e.properties.magnitude ?? e.properties.fire_radiance ?? 5;
      const isFire = e.type === "wildfire";
      return {
        lat,
        lng: lon,
        type: e.type,
        title: e.properties.title,
        time: e.properties.time,
        magnitude: mag,
        source_url: e.properties.source_url,
        radius: isFire ? 0.08 + Math.min(mag / 80, 0.35) : 0.25,
        altitude: isFire ? 0.01 : 0.02,
        color: isFire ? LAYER_COLORS.wildfire : LAYER_COLORS.hurricane,
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
      // globe.gl paths expect [lat, lng] pairs when using pathPoints
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

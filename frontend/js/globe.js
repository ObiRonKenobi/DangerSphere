/** Globe.gl initialisation and live layer rendering */

import Globe from "globe.gl";
import * as THREE from "three";
import {
  filterEvents,
  toCityMarkers,
  toHtmlHazards,
  toHurricanePaths,
  toPointMarkers,
} from "./layers.js";
import { showDetail } from "./ui.js";

let globe;
let radarTiles = [];
const textureLoader = new THREE.TextureLoader();
textureLoader.crossOrigin = "anonymous";

export function getGlobe() {
  return globe;
}

export function initGlobe(container) {
  globe = Globe()(container)
    .globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
    .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
    .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
    .showAtmosphere(true)
    .atmosphereColor("#2fe8ff")
    .atmosphereAltitude(0.18)
    .pointLat("lat")
    .pointLng("lng")
    .pointColor("color")
    .pointAltitude("altitude")
    .pointRadius("radius")
    .pointsData([])
    .pointLabel((d) => `${d.type}: ${d.title}`)
    .onPointClick((d) => {
      if (d) showDetail(d);
    })
    .pathsData([])
    .pathPoints("path")
    .pathPointLat((p) => p[0])
    .pathPointLng((p) => p[1])
    .pathColor("color")
    .pathStroke(1.2)
    .pathDashLength(0.6)
    .pathDashGap(0.15)
    .pathDashAnimateTime(4000)
    .htmlElementsData([])
    .htmlElement((d) => {
      const el = document.createElement("div");
      if (d.cls?.includes("volcano")) {
        el.className = d.cls;
        el.title = d.title;
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          showDetail(d);
        });
      } else if (d.isCity) {
        el.className = "city-pin";
        el.title = `${d.name}, ${d.country}`;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (typeof d.onClick === "function") d.onClick(d.city);
        });
      } else {
        el.className = d.cls;
        el.style.width = `${d.size}px`;
        el.style.height = `${d.size}px`;
        el.title = d.title;
        el.style.pointerEvents = "none";
      }
      return el;
    })
    .htmlElementVisibilityModifier((el, isVisible) => {
      el.style.opacity = isVisible ? 1 : 0;
    })
    .tilesData([])
    .tileLat("lat")
    .tileLng("lng")
    .tileWidth("width")
    .tileAltitude(0.01)
    .tileMaterial("material");

  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.enableDamping = true;

  let idleTimer;
  const resume = () => {
    clearTimeout(idleTimer);
    controls.autoRotate = false;
    idleTimer = setTimeout(() => {
      controls.autoRotate = true;
    }, 8000);
  };
  container.addEventListener("pointerdown", resume);

  window.addEventListener("resize", () => {
    globe.width(window.innerWidth);
    globe.height(window.innerHeight);
  });
  globe.width(window.innerWidth);
  globe.height(window.innerHeight);

  return globe;
}

export function applyLayers({ events, cities, layers, onCityClick }) {
  if (!globe) return;

  const visible = filterEvents(events, layers);

  const points =
    layers.wildfire || layers.hurricane
      ? toPointMarkers(
          visible.filter((e) => {
            if (e.type === "wildfire") return layers.wildfire;
            if (e.type === "hurricane") return layers.hurricane;
            return false;
          })
        )
      : [];

  const paths = layers.hurricane ? toHurricanePaths(visible) : [];

  const htmlHazards = toHtmlHazards(
    visible.filter((e) => {
      if (e.type === "earthquake") return layers.earthquake;
      if (e.type === "volcano") return layers.volcano;
      if (e.type === "tsunami") return layers.tsunami;
      return false;
    })
  );

  const cityHtml = layers.cities
    ? toCityMarkers(cities).map((c) => ({
        ...c,
        isCity: true,
        onClick: onCityClick,
      }))
    : [];

  globe.pointsData(points);
  globe.pathsData(paths);
  globe.htmlElementsData([...htmlHazards, ...cityHtml]);
  globe.tilesData(layers.radar ? radarTiles : []);
}

function loadTileMaterial(url) {
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(
          new THREE.MeshLambertMaterial({
            map: tex,
            transparent: true,
            opacity: 0.65,
            depthWrite: false,
          })
        );
      },
      undefined,
      () => resolve(null)
    );
  });
}

/**
 * RainViewer free radar — coarse global tiles for globe overview (max free z≈7).
 */
export async function setRadarFromRainViewer(mapsJson) {
  if (!globe || !mapsJson) {
    radarTiles = [];
    return;
  }

  const host = mapsJson.host;
  const frames = mapsJson.radar?.past || [];
  if (!frames.length) {
    radarTiles = [];
    return;
  }
  const path = frames[frames.length - 1].path;
  const z = 2;
  const n = 2 ** z;
  const width = 360 / n;
  const pending = [];

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const lng = ((x + 0.5) / n) * 360 - 180;
      const lat =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) /
        Math.PI;
      const url = `${host}${path}/256/${z}/${x}/${y}/2/1_1.png`;
      pending.push(
        loadTileMaterial(url).then((material) =>
          material
            ? { lat, lng, width, material, url }
            : null
        )
      );
    }
  }

  const loaded = await Promise.all(pending);
  radarTiles = loaded.filter(Boolean);
}

export function clearRadar() {
  radarTiles = [];
  if (globe) globe.tilesData([]);
}

export function focusLatLng(lat, lng, altitude = 1.8) {
  if (!globe) return;
  globe.pointOfView({ lat, lng, altitude }, 1000);
}

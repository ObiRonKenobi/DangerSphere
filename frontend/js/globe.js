/** Globe.gl — day/night terminator + hazard layers (no solar-calculator dep) */

import Globe from "globe.gl";
import {
  ShaderMaterial,
  TextureLoader,
  Vector2,
  SRGBColorSpace,
  MeshLambertMaterial,
} from "three";
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
let dayNightMaterial = null;

const TEX = {
  day: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-day.jpg",
  night: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg",
  bump: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png",
  sky: "https://cdn.jsdelivr.net/npm/three-globe/example/img/night-sky.png",
};

const textureLoader = new TextureLoader();
textureLoader.crossOrigin = "anonymous";

/** Approximate subsolar [lng, lat] — good enough for terminator visuals */
function sunPosAt(dt = Date.now()) {
  const d = new Date(dt);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = (dt - start) / 864e5;
  const decl =
    23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365.25);
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  let lng = 180 - hours * 15;
  while (lng < -180) lng += 360;
  while (lng > 180) lng -= 360;
  return [lng, decl];
}

const dayNightShader = {
  vertexShader: `
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    #define PI 3.141592653589793
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    varying vec3 vNormal;
    varying vec2 vUv;

    float toRad(in float a) { return a * PI / 180.0; }

    vec3 Polar2Cartesian(in vec2 c) {
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(
        sin(phi) * cos(theta),
        cos(phi),
        sin(phi) * sin(theta)
      );
    }

    void main() {
      float invLon = toRad(globeRotation.x);
      float invLat = -toRad(globeRotation.y);
      mat3 rotX = mat3(
        1.0, 0.0, 0.0,
        0.0, cos(invLat), -sin(invLat),
        0.0, sin(invLat), cos(invLat)
      );
      mat3 rotY = mat3(
        cos(invLon), 0.0, sin(invLon),
        0.0, 1.0, 0.0,
        -sin(invLon), 0.0, cos(invLon)
      );
      vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
      float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
      vec4 dayColor = texture2D(dayTexture, vUv);
      vec4 nightColor = texture2D(nightTexture, vUv);
      float blendFactor = smoothstep(-0.1, 0.1, intensity);
      gl_FragColor = mix(nightColor, dayColor, blendFactor);
    }
  `,
};

export function getGlobe() {
  return globe;
}

function startDayNight(material) {
  const tick = () => {
    if (material) {
      material.uniforms.sunPosition.value.set(...sunPosAt());
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function initGlobe(container) {
  globe = Globe()(container)
    .backgroundImageUrl(TEX.sky)
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
    .pathStroke(1.5)
    .pathDashLength(0.6)
    .pathDashGap(0.15)
    .pathDashAnimateTime(4000)
    .htmlElementsData([])
    .htmlLat("lat")
    .htmlLng("lng")
    .htmlAltitude(0.012)
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
    .tilesData([])
    .tileLat("lat")
    .tileLng("lng")
    .tileWidth("width")
    .tileAltitude(0.01)
    .tileMaterial("material");

  // Immediate fallback so we never sit on black/night-only while shaders load
  globe.globeImageUrl(TEX.day).bumpImageUrl(TEX.bump);

  Promise.all([
    textureLoader.loadAsync(TEX.day),
    textureLoader.loadAsync(TEX.night),
  ])
    .then(([dayTexture, nightTexture]) => {
      dayTexture.colorSpace = SRGBColorSpace;
      nightTexture.colorSpace = SRGBColorSpace;
      dayNightMaterial = new ShaderMaterial({
        uniforms: {
          dayTexture: { value: dayTexture },
          nightTexture: { value: nightTexture },
          sunPosition: { value: new Vector2(...sunPosAt()) },
          globeRotation: { value: new Vector2() },
        },
        vertexShader: dayNightShader.vertexShader,
        fragmentShader: dayNightShader.fragmentShader,
      });
      globe.globeMaterial(dayNightMaterial);
      globe.onZoom(({ lng, lat }) => {
        dayNightMaterial.uniforms.globeRotation.value.set(lng, lat);
      });
      startDayNight(dayNightMaterial);
    })
    .catch((err) => {
      console.warn("Day/night shader failed; keeping day map", err);
    });

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
  const points = toPointMarkers(visible, layers);
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
        tex.colorSpace = SRGBColorSpace;
        resolve(
          new MeshLambertMaterial({
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
          material ? { lat, lng, width, material, url } : null
        )
      );
    }
  }
  radarTiles = (await Promise.all(pending)).filter(Boolean);
}

export function clearRadar() {
  radarTiles = [];
  if (globe) globe.tilesData([]);
}

export function focusLatLng(lat, lng, altitude = 1.8) {
  if (!globe) return;
  globe.pointOfView({ lat, lng, altitude }, 1000);
}

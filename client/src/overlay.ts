import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { ServerMessage } from "./types";
import { decodePolyline } from "./polyline";
import { strings } from "./strings";
import { Theme, RASTER_STYLE, applyTheme, registerPmtiles } from "./themes";
import { warmEndpointFeatureCollection, warmGradientExpression } from "./gradients";
import { haversineMeters } from "./geo";
import { formatSpeedMs, formatAltitude } from "./units";
import { Connection } from "./net";
import { emptyFeatureCollection, ensureGeoJsonSource, ensureLayer, moveLayersToTop, setLineString } from "./map-layers";

// URL params for OBS configurability
const params = new URLSearchParams(window.location.search);
const zoom = parseFloat(params.get("zoom") ?? "15");
const followMode = params.get("follow") ?? "streamer"; // streamer | route | trail | off
const showRoute = params.get("route") !== "0";
const showTrail = params.get("trail") !== "0";
const showTelemetry = params.get("telemetry") !== "0";
const staleAfterMs = Number.parseInt(params.get("staleMs") ?? "30000", 10);
const themeParam = (params.get("theme") ?? "dark") as Theme;

/** Default location when no one is live (Seattle downtown). */
const FALLBACK_LAT = 47.6062;
const FALLBACK_LON = -122.3321;

// ── Map ────────────────────────────────────────────────────────────────

registerPmtiles();

const map = new maplibregl.Map({
  container: "map",
  style: RASTER_STYLE,
  center: [FALLBACK_LON, FALLBACK_LAT],
  zoom,
  interactive: false,
  attributionControl: false,
});

// ── Custom layers (re-added on style.load) ────────────────────────────

let routePolyline: string | null = null;
let routeCoords: [number, number][] = [];
let trailCoords: [number, number][] = [];
let hasPosition = false;
let currentPosition: [number, number] | null = null;
let targetPosition: [number, number] | null = null;
let markerAnimation: number | null = null;
let lastLocationAt = 0;
let lastLocationTimestampMs: number | null = null;
let lastLiveStatus: boolean | null = null;

function addCustomLayers() {
  ensureGeoJsonSource(map, "trail", { lineMetrics: true });
  ensureLayer(map, {
    id: "trail-line-casing",
    type: "line",
    source: "trail",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#020617", "line-width": 9, "line-opacity": 0.72 },
  });
  ensureLayer(map, {
    id: "trail-line",
    type: "line",
    source: "trail",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-gradient": warmGradientExpression(), "line-width": 6, "line-opacity": showTrail ? 0.95 : 0 },
  });

  ensureGeoJsonSource(map, "trail-endpoints");
  ensureLayer(map, {
    id: "trail-endpoint-halo",
    type: "circle",
    source: "trail-endpoints",
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": ["case", ["==", ["get", "kind"], "end"], 8, 7],
      "circle-opacity": 0.9,
    },
  });
  ensureLayer(map, {
    id: "trail-endpoint",
    type: "circle",
    source: "trail-endpoints",
    paint: {
      "circle-color": ["get", "color"],
      "circle-radius": ["case", ["==", ["get", "kind"], "end"], 5, 4],
      "circle-stroke-color": "#111827",
      "circle-stroke-width": 1.5,
    },
  });

  ensureGeoJsonSource(map, "route");
  ensureLayer(map, {
    id: "route-line-casing",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#020617", "line-width": 10, "line-opacity": showRoute ? 0.75 : 0 },
  });
  ensureLayer(map, {
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#14f1d9", "line-width": 6, "line-opacity": showRoute ? 0.92 : 0 },
  });

  // Keep trail endpoint dots above the route line so start/end stay visible.
  moveLayersToTop(map, ["trail-endpoint-halo", "trail-endpoint"]);
}

function reapplyData() {
  if (routePolyline) updateRouteLayer();
  if (trailCoords.length >= 2) updateTrailLayer();
}

map.on("style.load", () => {
  addCustomLayers();
  reapplyData();
});

// ── Streamer marker ───────────────────────────────────────────────────

/** Accuracy thresholds for dot sizing (in metres) */
const ACCURACY_MIN = 5;     // best — smallest dot
const ACCURACY_MAX = 100;   // worst — largest dot
const ACCURACY_OPAQUE = 50; // below this → solid; above → fades to transparent

const dot = document.createElement("div");
dot.className = "streamer-dot";
const streamerMarker = new maplibregl.Marker({ element: dot })
  .setLngLat([0, 0])
  .addTo(map);

function applyAccuracyStyle(accuracy: number | null | undefined) {
  if (accuracy == null || !Number.isFinite(accuracy)) {
    // Unknown accuracy → default solid dot
    dot.style.width = "20px";
    dot.style.height = "20px";
    dot.style.opacity = "1";
    dot.style.setProperty("--dot-transparent", "0");
    return;
  }

  // Clamp accuracy to our range
  const clamped = Math.max(ACCURACY_MIN, Math.min(ACCURACY_MAX, accuracy));

  // Map accuracy to dot size: 20px (best) → 44px (worst)
  const t = (clamped - ACCURACY_MIN) / (ACCURACY_MAX - ACCURACY_MIN);
  const size = Math.round(20 + t * 24);
  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;

  // Opacity / transparency above threshold
  if (accuracy > ACCURACY_OPAQUE) {
    const opacityT = Math.min(1, (accuracy - ACCURACY_OPAQUE) / (ACCURACY_MAX - ACCURACY_OPAQUE));
    dot.style.opacity = String(1 - opacityT * 0.55); // fades to ~0.45 at worst
    dot.classList.add("accuracy-low");
  } else {
    dot.style.opacity = "1";
    dot.classList.remove("accuracy-low");
  }
}

// ── Telemetry DOM ─────────────────────────────────────────────────────

const overlayEl = document.getElementById("overlay")!;
const telemetryEl = document.getElementById("telemetry")!;
const statusBadge = document.getElementById("status-badge")!;
const headingArrow = document.getElementById("heading-arrow")!;
const telSpeed = document.getElementById("tel-speed")!;
const telAlt = document.getElementById("tel-alt")!;
const telCoords = document.getElementById("tel-coords")!;

if (!showTelemetry) telemetryEl.style.display = "none";

// ── Message handler ───────────────────────────────────────────────────

function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "location": {
      lastLocationAt = Date.now();
      const previousTimestampMs = lastLocationTimestampMs;
      lastLocationTimestampMs = msg.timestamp_ms;
      // Remove any stale/offline class when live data arrives
      overlayEl.classList.remove("stale", "offline");
      statusBadge.className = "status-badge status-live";
      statusBadge.textContent = ""; // Hide badge when live

      const nextPosition: [number, number] = [msg.lon, msg.lat];
      const previousPosition = targetPosition ?? currentPosition;
      targetPosition = nextPosition;

      if (!hasPosition) {
        hasPosition = true;
        currentPosition = nextPosition;
        streamerMarker.setLngLat(nextPosition);
        followCamera(nextPosition);
      } else {
        animateStreamerTo(nextPosition);
        if (followMode === "streamer") map.easeTo({ center: nextPosition, duration: 1000 });
      }

      const heading = msg.heading ?? (previousPosition ? bearingDegrees(previousPosition, nextPosition) : null);
      if (heading != null && Number.isFinite(heading)) {
        headingArrow.style.transform = `rotate(${heading}deg)`;
        headingArrow.classList.remove("heading-unknown");
      } else {
        headingArrow.classList.add("heading-unknown");
      }

      // Update dot sizing based on reported accuracy
      applyAccuracyStyle(finiteNumber(msg.accuracy));

      const speedMps = finiteNumber(msg.speed)
        ?? estimateSpeedMps(previousPosition, nextPosition, previousTimestampMs, msg.timestamp_ms);
      const altitude = finiteNumber(msg.altitude);

      telSpeed.textContent =
        speedMps != null ? formatSpeedMs(speedMps, "imperial") : strings.overlay.speedUnknown;
      telAlt.textContent =
        altitude != null ? formatAltitude(altitude, "imperial") + " alt" : strings.overlay.altUnknown;
      telCoords.textContent = `${msg.lat.toFixed(4)}, ${msg.lon.toFixed(4)}`;
      break;
    }

    case "route_result": {
      routePolyline = msg.polyline;
      updateRouteLayer();
      if (followMode === "route") fitCoords(routeCoords, { bottom: 40 });
      break;
    }

    case "trail": {
      trailCoords = msg.coords as [number, number][];
      updateTrailLayer();
      if (followMode === "trail") fitCoords(trailCoords, { bottom: 40 });
      break;
    }

    case "live_status": {
      lastLiveStatus = msg.live;
      if (!msg.live) {
        setOverlayStatus("offline", strings.overlay.offline);
      }
      break;
    }
  }
}

function updateRouteLayer() {
  if (!routePolyline) return;
  routeCoords = decodePolyline(routePolyline);
  setLineString(map, "route", routeCoords, { minPoints: 1 });
}

function updateTrailLayer() {
  const endpointSrc = map.getSource("trail-endpoints") as maplibregl.GeoJSONSource | undefined;
  if (trailCoords.length < 2) {
    setLineString(map, "trail", trailCoords);
    endpointSrc?.setData(emptyFeatureCollection());
    return;
  }
  setLineString(map, "trail", trailCoords);
  endpointSrc?.setData(warmEndpointFeatureCollection(trailCoords));
}

function animateStreamerTo(next: [number, number]) {
  const start = currentPosition ?? next;
  const startedAt = performance.now();
  const duration = 1200;
  if (markerAnimation != null) cancelAnimationFrame(markerAnimation);

  const frame = (now: number) => {
    const t = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const pos: [number, number] = [
      start[0] + (next[0] - start[0]) * eased,
      start[1] + (next[1] - start[1]) * eased,
    ];
    currentPosition = pos;
    streamerMarker.setLngLat(pos);
    if (t < 1) markerAnimation = requestAnimationFrame(frame);
  };
  markerAnimation = requestAnimationFrame(frame);
}

function followCamera(center: [number, number]) {
  if (followMode !== "off") map.jumpTo({ center });
}

function fitCoords(coords: [number, number][], paddingOverrides: Partial<maplibregl.PaddingOptions> = {}) {
  if (coords.length < 2 || followMode === "off") return;
  const bounds = coords.reduce(
    (b, coord) => b.extend(coord),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
  map.fitBounds(bounds, {
    padding: { top: 80, right: 80, bottom: 80, left: 80, ...paddingOverrides },
    maxZoom: zoom,
    duration: 800,
  });
}

function estimateSpeedMps(
  previousPosition: [number, number] | null,
  nextPosition: [number, number],
  previousTimestampMs: number | null,
  nextTimestampMs: number,
): number | null {
  if (!previousPosition || previousTimestampMs == null) return null;
  const dtSeconds = (nextTimestampMs - previousTimestampMs) / 1000;
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return null;
  const meters = haversineMeters(previousPosition, nextPosition);
  const speed = meters / dtSeconds;
  return Number.isFinite(speed) ? speed : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bearingDegrees(from: [number, number], to: [number, number]): number | null {
  const [lon1, lat1] = from.map((v) => v * Math.PI / 180) as [number, number];
  const [lon2, lat2] = to.map((v) => v * Math.PI / 180) as [number, number];
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return Number.isFinite(bearing) ? bearing : null;
}

function setOverlayStatus(kind: "live" | "stale" | "offline" | "waiting", label: string) {
  overlayEl.classList.toggle("stale", kind === "stale");
  overlayEl.classList.toggle("offline", kind === "offline");
  statusBadge.className = `status-badge status-${kind}`;
  statusBadge.textContent = label;
}

setInterval(() => {
  if (lastLiveStatus === false) return;
  if (!lastLocationAt) {
    setOverlayStatus("waiting", strings.overlay.waitingForGps);
    return;
  }
  const age = Date.now() - lastLocationAt;
  if (age > staleAfterMs) {
    setOverlayStatus("stale", strings.overlay.staleGps(Math.round(age / 1000)));
  } else {
    // GPS is live and fresh — hide the status badge
    overlayEl.classList.remove("stale", "offline");
    statusBadge.className = "status-badge status-live";
    statusBadge.textContent = "";
  }
}, 1000);

// ── Start ──────────────────────────────────────────────────────────────

// Apply theme from query param, then connect
map.once("load", () => {
  applyTheme(map, themeParam, () => {
    addCustomLayers();
    reapplyData();
  });
});

new Connection(handleMessage, () => {}, {
  client: "overlay",
  countAsViewer: false,
  logPrefix: "[overlay]",
});

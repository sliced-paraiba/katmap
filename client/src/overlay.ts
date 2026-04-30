import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { ServerMessage } from "./types";
import { decodePolyline } from "./polyline";
import { strings } from "./strings";

// URL params for OBS configurability
const params = new URLSearchParams(window.location.search);
const zoom = parseFloat(params.get("zoom") ?? "15");
const followMode = params.get("follow") ?? "streamer"; // streamer | route | trail | off
const showRoute = params.get("route") !== "0";
const showTrail = params.get("trail") !== "0";
const showTelemetry = params.get("telemetry") !== "0";
const staleAfterMs = Number.parseInt(params.get("staleMs") ?? "30000", 10);

// ── WebSocket ──────────────────────────────────────────────────────────

let ws: WebSocket;
let reconnectDelay = 1000;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?client=overlay`);

  ws.onopen = () => {
    console.log("[overlay] connected");
    reconnectDelay = 1000;
  };

  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch (err) {
      console.error("[overlay] parse error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[overlay] disconnected, reconnecting…");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };

  ws.onerror = () => ws.close();
}

// ── Map ────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
      },
    },
    layers: [{
      id: "osm",
      type: "raster",
      source: "osm",
      paint: {
        "raster-opacity": 0.82,
        "raster-contrast": 0.18,
        "raster-saturation": -0.35,
        "raster-brightness-min": 0.08,
        "raster-brightness-max": 0.92,
      },
    }],
  },
  center: [0, 0],
  zoom,
  interactive: false,
  attributionControl: false,
});

// Always use raster tiles — lightweight and fast for a small overlay

// ── Custom layers (re-added on style.load) ────────────────────────────

let routePolyline: string | null = null;
let routeCoords: [number, number][] = [];
let routeDurationMin: number | null = null;
let trailCoords: [number, number][] = [];
let hasPosition = false;
let currentPosition: [number, number] | null = null;
let targetPosition: [number, number] | null = null;
let markerAnimation: number | null = null;
let lastLocationAt = 0;
let lastLocationTimestampMs: number | null = null;
let lastLiveStatus: boolean | null = null;

function addCustomLayers() {
  if (!map.getSource("trail")) {
    map.addSource("trail", {
      type: "geojson",
      lineMetrics: true,
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trail-line-casing")) {
    map.addLayer({
      id: "trail-line-casing",
      type: "line",
      source: "trail",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#020617", "line-width": 9, "line-opacity": 0.72 },
    });
  }
  if (!map.getLayer("trail-line")) {
    map.addLayer({
      id: "trail-line",
      type: "line",
      source: "trail",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-gradient": warmGradientExpression(), "line-width": 6, "line-opacity": showTrail ? 0.95 : 0 },
    });
  }

  if (!map.getSource("trail-endpoints")) {
    map.addSource("trail-endpoints", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trail-endpoint-halo")) {
    map.addLayer({
      id: "trail-endpoint-halo",
      type: "circle",
      source: "trail-endpoints",
      paint: {
        "circle-color": "#ffffff",
        "circle-radius": ["case", ["==", ["get", "kind"], "end"], 8, 7],
        "circle-opacity": 0.9,
      },
    });
  }
  if (!map.getLayer("trail-endpoint")) {
    map.addLayer({
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
  }

  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("route-line-casing")) {
    map.addLayer({
      id: "route-line-casing",
      type: "line",
      source: "route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#020617", "line-width": 10, "line-opacity": showRoute ? 0.75 : 0 },
    });
  }
  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#14f1d9", "line-width": 6, "line-opacity": showRoute ? 0.92 : 0 },
    });
  }

  // Keep trail endpoint dots above the route line so start/end stay visible.
  if (map.getLayer("trail-endpoint-halo")) map.moveLayer("trail-endpoint-halo");
  if (map.getLayer("trail-endpoint")) map.moveLayer("trail-endpoint");
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

const dot = document.createElement("div");
dot.className = "streamer-dot";
const streamerMarker = new maplibregl.Marker({ element: dot })
  .setLngLat([0, 0])
  .addTo(map);

// ── Telemetry DOM ─────────────────────────────────────────────────────

const overlayEl = document.getElementById("overlay")!;
const telemetryEl = document.getElementById("telemetry")!;
const statusBadge = document.getElementById("status-badge")!;
const headingArrow = document.getElementById("heading-arrow")!;
const telSpeed = document.getElementById("tel-speed")!;
const telEta = document.getElementById("tel-eta")!;
const telAlt = document.getElementById("tel-alt")!;
const telCoords = document.getElementById("tel-coords")!;

if (!showTelemetry) telemetryEl.style.display = "none";

// ── Message handler ───────────────────────────────────────────────────

function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "location": {
      lastLocationAt = Date.now();
      lastLocationTimestampMs = msg.timestamp_ms;
      lastLiveStatus = true;
      setOverlayStatus("live", strings.overlay.liveGps);

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

      telSpeed.textContent =
        msg.speed != null ? strings.overlay.speed((msg.speed * 3.6).toFixed(1)) : strings.overlay.speedUnknown;
      telAlt.textContent =
        msg.altitude != null ? strings.overlay.altitude(`${Math.round(msg.altitude)}`) : strings.overlay.altUnknown;
      telCoords.textContent = `${msg.lat.toFixed(4)}, ${msg.lon.toFixed(4)}`;
      break;
    }

    case "route_result": {
      routePolyline = msg.polyline;
      routeDurationMin = msg.duration_min;
      telEta.textContent = strings.overlay.etaLabel(formatEta(routeDurationMin));
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
      if (!msg.live) setOverlayStatus("offline", strings.overlay.offline);
      break;
    }
  }
}

function updateRouteLayer() {
  const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (!src || !routePolyline) return;
  routeCoords = decodePolyline(routePolyline);
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: routeCoords },
  });
}

function updateTrailLayer() {
  const src = map.getSource("trail") as maplibregl.GeoJSONSource | undefined;
  const endpointSrc = map.getSource("trail-endpoints") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (trailCoords.length < 2) {
    src.setData({ type: "FeatureCollection", features: [] });
    endpointSrc?.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: trailCoords },
  });
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

function bearingDegrees(from: [number, number], to: [number, number]): number | null {
  const [lon1, lat1] = from.map((v) => v * Math.PI / 180) as [number, number];
  const [lon2, lat2] = to.map((v) => v * Math.PI / 180) as [number, number];
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return Number.isFinite(bearing) ? bearing : null;
}

function formatEta(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "--";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
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
  } else if (lastLocationTimestampMs) {
    setOverlayStatus("live", strings.overlay.liveGps);
  }
}, 1000);

function warmGradientExpression(): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["line-progress"],
    0,
    "#fbbf24",
    0.3,
    "#f97316",
    0.6,
    "#ef4444",
    0.85,
    "#dc2626",
    1,
    "#991b1b",
  ] as maplibregl.ExpressionSpecification;
}

function warmEndpointFeatureCollection(coords: [number, number][]) {
  const start = coords[0];
  const end = coords[coords.length - 1];

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "start", color: "#fbbf24" },
        geometry: { type: "Point" as const, coordinates: start },
      },
      {
        type: "Feature" as const,
        properties: { kind: "end", color: "#991b1b" },
        geometry: { type: "Point" as const, coordinates: end },
      },
    ],
  };
}

// ── Start ──────────────────────────────────────────────────────────────

connect();

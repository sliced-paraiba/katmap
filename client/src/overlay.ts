import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { ServerMessage } from "./types";
import { decodePolyline } from "./polyline";

const TILES_BASE = (window.location.origin ?? "") + "/tiles";

// URL params for OBS configurability
const params = new URLSearchParams(window.location.search);
const zoom = parseFloat(params.get("zoom") ?? "15");

// ── WebSocket ──────────────────────────────────────────────────────────

let ws: WebSocket;
let reconnectDelay = 1000;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

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

const pmProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", pmProtocol.tile);

const rasterStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const map = new maplibregl.Map({
  container: "map",
  style: rasterStyle,
  center: [0, 0],
  zoom,
  interactive: false,
  attributionControl: false,
});

// Try dark-matter vector tiles, fall back to raster
(async () => {
  try {
    const r = await fetch(`${TILES_BASE}/dark-matter.json`);
    if (r.ok) {
      map.setStyle(await r.json());
    }
  } catch {
    // raster fallback is already set
  }
})();

// ── Custom layers (re-added on style.load) ────────────────────────────

let routePolyline: string | null = null;
let trailCoords: [number, number][] = [];
let hasPosition = false;

function addCustomLayers() {
  if (!map.getSource("trail")) {
    map.addSource("trail", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trail-line")) {
    map.addLayer({
      id: "trail-line",
      type: "line",
      source: "trail",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#FF6B00", "line-width": 2, "line-opacity": 0.65 },
    });
  }

  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#0f9b8e", "line-width": 3, "line-opacity": 0.8 },
    });
  }
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

const headingArrow = document.getElementById("heading-arrow")!;
const telSpeed = document.getElementById("tel-speed")!;
const telAlt = document.getElementById("tel-alt")!;
const telCoords = document.getElementById("tel-coords")!;

// ── Message handler ───────────────────────────────────────────────────

function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "location": {
      if (!hasPosition) {
        hasPosition = true;
        map.jumpTo({ center: [msg.lon, msg.lat] });
      } else {
        map.easeTo({ center: [msg.lon, msg.lat], duration: 1000 });
      }
      streamerMarker.setLngLat([msg.lon, msg.lat]);

      if (msg.heading != null) {
        headingArrow.style.transform = `rotate(${msg.heading}deg)`;
      }

      telSpeed.textContent =
        msg.speed != null ? `${(msg.speed * 3.6).toFixed(1)} km/h` : "-- km/h";
      telAlt.textContent =
        msg.altitude != null ? `${Math.round(msg.altitude)} m` : "-- m";
      telCoords.textContent = `${msg.lat.toFixed(4)}, ${msg.lon.toFixed(4)}`;
      break;
    }

    case "route_result": {
      routePolyline = msg.polyline;
      updateRouteLayer();
      break;
    }

    case "trail": {
      trailCoords = msg.coords as [number, number][];
      updateTrailLayer();
      break;
    }
  }
}

function updateRouteLayer() {
  const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (!src || !routePolyline) return;
  const coords = decodePolyline(routePolyline);
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  });
}

function updateTrailLayer() {
  const src = map.getSource("trail") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (trailCoords.length < 2) {
    src.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: trailCoords },
  });
}

// ── Start ──────────────────────────────────────────────────────────────

connect();

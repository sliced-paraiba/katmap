import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./snipe.css";
import { decodePolyline } from "./polyline";
import { distanceMeters } from "./geo";
import { formatDistanceKm } from "./units";
import { escapeHtml } from "./html";
import { fitCoords, markerElement } from "./map-utils";
import { ApiError, bindTokenInput, createTokenApi } from "./api";
import { emptyFeatureCollection, ensureGeoJsonSource, ensureLayer, lineStringFeature, setGeoJsonData } from "./map-layers";
import type { LonLat } from "./geo";
import type { SnipeLocation, SnipeRoute, SnipeRouteRequest, SnipeStatus, TravelMode, UserLocation } from "./api-types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenEl = $("token") as HTMLInputElement;
bindTokenInput(tokenEl, "katmap-snipe-token");
const api = createTokenApi(tokenEl, { parse: "json" });

let mode: TravelMode = "walking";
let userLoc: UserLocation | null = null;
let streamerLoc: SnipeLocation | null = null;
let lastRouteAt = 0;
let lastRouteUser: UserLocation | null = null;
let lastRouteStreamer: SnipeLocation | null = null;
let userMarker: maplibregl.Marker | null = null;
let streamerMarker: maplibregl.Marker | null = null;
let routeTimer: number | null = null;
let follow = true;
let watchId: number | null = null;
let routeBackoffUntil = 0;

const map = new maplibregl.Map({
  container: "map",
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [-122.3321, 47.6062],
  zoom: 13,
});
map.addControl(new maplibregl.NavigationControl());
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
map.on("load", () => {
  ensureGeoJsonSource(map, "route");
  ensureLayer(map, { id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#020617", "line-width": 8, "line-opacity": 0.7 } });
  ensureLayer(map, { id: "route-line", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#22c55e", "line-width": 5, "line-opacity": 0.95 } });
});
new ResizeObserver(() => map.resize()).observe($("map"));
window.addEventListener("resize", () => map.resize());

function setStatus(s: string) { $("status").textContent = s; }
function updateMarkers() {
  if (userLoc) {
    if (!userMarker) userMarker = new maplibregl.Marker({ element: markerElement("user") }).addTo(map);
    userMarker.setLngLat([userLoc.lon, userLoc.lat]);
  }
  if (streamerLoc) {
    if (!streamerMarker) streamerMarker = new maplibregl.Marker({ element: markerElement("streamer") }).addTo(map);
    streamerMarker.setLngLat([streamerLoc.lon, streamerLoc.lat]);
  }
}

$("start").onclick = () => startGps();
$("follow").onclick = () => {
  follow = !follow;
  $("follow").classList.toggle("active", follow);
};
document.querySelectorAll<HTMLButtonElement>(".mode").forEach((btn) => {
  btn.onclick = () => {
    mode = btn.dataset.mode as TravelMode;
    document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b === btn));
    void route(true);
  };
});

function startGps() {
  if (!tokenEl.value) { setStatus("Missing token"); return; }
  if (!navigator.geolocation) { setStatus("Geolocation unsupported"); return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition((pos) => {
    userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
    updateMarkers();
    void route();
  }, (err) => setStatus(`GPS error: ${err.message}`), { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  if (routeTimer != null) clearInterval(routeTimer);
  routeTimer = window.setInterval(() => void route(), 3000);
  void route(true);
}

async function route(force = false) {
  if (!tokenEl.value) return;
  if (!force && Date.now() < routeBackoffUntil) return;
  try {
    const status = await api<SnipeStatus>("/api/snipe/status");
    streamerLoc = status.streamer ? { lat: status.streamer.lat, lon: status.streamer.lon } : null;
    updateMarkers();
    if (!status.live || !streamerLoc) {
      setStatus(status.age_ms != null ? `Streamer is offline · last update ${formatAge(status.age_ms)} ago` : "Streamer is offline");
      clearRoute();
      return;
    }
    if (!userLoc) { setStatus("Waiting for your GPS…"); return; }
    const now = Date.now();
    const movedUser = !lastRouteUser || distanceMeters(userLoc, lastRouteUser) > 20;
    const movedStreamer = !lastRouteStreamer || distanceMeters(streamerLoc, lastRouteStreamer) > 20;
    if (!force && !movedUser && !movedStreamer && now - lastRouteAt < 10000) return;
    const body: SnipeRouteRequest = { lat: userLoc.lat, lon: userLoc.lon, mode };
    const data = await api<SnipeRoute>("/api/snipe/route", { method: "POST", body: JSON.stringify(body) });
    streamerLoc = data.streamer;
    lastRouteAt = now;
    lastRouteUser = { ...userLoc };
    lastRouteStreamer = { ...streamerLoc };
    renderRoute(data);
    const ageMs = status.age_ms ?? 0;
    if (ageMs > 60_000) {
      setStatus(`Updated; streamer location is ${formatAge(ageMs)} old`);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      const seconds = e.retryAfter ?? 15;
      routeBackoffUntil = Date.now() + seconds * 1000;
      setStatus(`Rate limited; retrying in ${seconds}s`);
    } else {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }
}

function clearRoute() {
  setGeoJsonData(map, "route", emptyFeatureCollection());
  $("summary").textContent = "No route";
  $("steps").innerHTML = '<li class="hint">Waiting for the streamer to go live.</li>';
}
function renderRoute(data: SnipeRoute) {
  const coords = decodePolyline(data.polyline);
  setGeoJsonData(map, "route", coords.length ? lineStringFeature(coords) : emptyFeatureCollection());
  $("summary").textContent = `${data.distance_km.toFixed(1)} km · ${Math.round(data.duration_min)} min · ${mode}`;
  $("steps").innerHTML = data.maneuvers.slice(0, 30).map((m) => `<li>${escapeHtml(m.instruction)} <span class="hint">${formatDistanceKm(m.distance_km)}</span></li>`).join("") || '<li class="hint">No maneuvers.</li>';
  setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  updateMarkers();
  if (follow && coords.length) fit(coords);
}
function fit(coords: LonLat[]) {
  fitCoords(map, coords, { padding: { top: 80, right: 40, bottom: 220, left: 40 }, maxZoom: 17, duration: 400 });
}
function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

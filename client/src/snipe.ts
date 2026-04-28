import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./snipe.css";
import { decodePolyline } from "./polyline";

type LonLat = [number, number];
type TravelMode = "walking" | "cycling" | "car";

interface Location { lat: number; lon: number; }
interface UserLocation extends Location { accuracy?: number; }
interface SnipeStatus { live: boolean; streamer: Location | null; }
interface SnipeManeuver { instruction: string; distance_km: number; duration_min: number; street_names?: string[]; }
interface SnipeRoute { streamer: Location; polyline: string; distance_km: number; duration_min: number; maneuvers: SnipeManeuver[]; }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenEl = $("token") as HTMLInputElement;
tokenEl.value = localStorage.getItem("katmap-snipe-token") || "";
tokenEl.addEventListener("input", () => localStorage.setItem("katmap-snipe-token", tokenEl.value));

let mode: TravelMode = "walking";
let userLoc: UserLocation | null = null;
let streamerLoc: Location | null = null;
let lastRouteAt = 0;
let lastRouteUser: UserLocation | null = null;
let lastRouteStreamer: Location | null = null;
let userMarker: maplibregl.Marker | null = null;
let streamerMarker: maplibregl.Marker | null = null;
let routeTimer: number | null = null;
let follow = true;
let watchId: number | null = null;

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
  map.addSource("route", { type: "geojson", data: emptyFc() });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#020617", "line-width": 8, "line-opacity": 0.7 } });
  map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#22c55e", "line-width": 5, "line-opacity": 0.95 } });
});
new ResizeObserver(() => map.resize()).observe($("map"));
window.addEventListener("resize", () => map.resize());

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${tokenEl.value}`, "Content-Type": "application/json" };
}
async function api<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(await res.text() || res.statusText);
  return await res.json() as T;
}
function setStatus(s: string) { $("status").textContent = s; }
function marker(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `marker ${className}`;
  return el;
}
function updateMarkers() {
  if (userLoc) {
    if (!userMarker) userMarker = new maplibregl.Marker({ element: marker("user") }).addTo(map);
    userMarker.setLngLat([userLoc.lon, userLoc.lat]);
  }
  if (streamerLoc) {
    if (!streamerMarker) streamerMarker = new maplibregl.Marker({ element: marker("streamer") }).addTo(map);
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
  try {
    const status = await api<SnipeStatus>("/api/snipe/status");
    streamerLoc = status.streamer ? { lat: status.streamer.lat, lon: status.streamer.lon } : null;
    updateMarkers();
    if (!status.live || !streamerLoc) { setStatus("Streamer is offline"); clearRoute(); return; }
    if (!userLoc) { setStatus("Waiting for your GPS…"); return; }
    const now = Date.now();
    const movedUser = !lastRouteUser || distM(userLoc, lastRouteUser) > 20;
    const movedStreamer = !lastRouteStreamer || distM(streamerLoc, lastRouteStreamer) > 20;
    if (!force && !movedUser && !movedStreamer && now - lastRouteAt < 10000) return;
    const data = await api<SnipeRoute>("/api/snipe/route", { method: "POST", body: JSON.stringify({ lat: userLoc.lat, lon: userLoc.lon, mode }) });
    streamerLoc = data.streamer;
    lastRouteAt = now;
    lastRouteUser = { ...userLoc };
    lastRouteStreamer = { ...streamerLoc };
    renderRoute(data);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function clearRoute() {
  const source = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(emptyFc());
  $("summary").textContent = "No route";
  $("steps").innerHTML = '<li class="hint">Waiting for the streamer to go live.</li>';
}
function renderRoute(data: SnipeRoute) {
  const coords = decodePolyline(data.polyline);
  const source = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(coords.length ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } : emptyFc());
  $("summary").textContent = `${data.distance_km.toFixed(1)} km · ${Math.round(data.duration_min)} min · ${mode}`;
  $("steps").innerHTML = data.maneuvers.slice(0, 30).map((m) => `<li>${escapeHtml(m.instruction)} <span class="hint">${formatKm(m.distance_km)}</span></li>`).join("") || '<li class="hint">No maneuvers.</li>';
  setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  updateMarkers();
  if (follow && coords.length) fit(coords);
}
function fit(coords: LonLat[]) {
  requestAnimationFrame(() => {
    map.resize();
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: { top: 80, right: 40, bottom: 220, left: 40 }, maxZoom: 17, duration: 400 });
  });
}
function formatKm(km: number): string { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }
function distM(a: Location, b: Location): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./admin-history.css";

type LonLat = [number, number];

interface TrailEdits {
  hidden_indices: number[];
  moved_points: Record<string, LonLat>;
}

interface BreadcrumbTelemetry {
  timestamp_ms: number;
  lon: number;
  lat: number;
  altitude?: number | null;
  accuracy?: number | null;
  altitude_accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

interface AdminHistoryEntry {
  id: number;
  streamer_id: string;
  platform: string;
  started_at: number;
  ended_at: number;
  session_id?: string | null;
  stream_title?: string | null;
  viewer_count?: number | null;
  hidden: boolean;
  completed: boolean;
  breadcrumbs: LonLat[];
  edited_breadcrumbs: LonLat[];
  edits: TrailEdits;
  telemetry?: BreadcrumbTelemetry[] | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenEl = $("token") as HTMLInputElement;
tokenEl.value = localStorage.getItem("katmap-admin-token") || "";
tokenEl.addEventListener("input", () => localStorage.setItem("katmap-admin-token", tokenEl.value));

let entries: AdminHistoryEntry[] = [];
let current: AdminHistoryEntry | null = null;
let selectedIndex: number | null = null;
let markers: maplibregl.Marker[] = [];

const map = new maplibregl.Map({
  container: "map",
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
  zoom: 12,
});

map.addControl(new maplibregl.NavigationControl());
map.on("load", () => {
  map.addSource("trail", { type: "geojson", lineMetrics: true, data: emptyFc() });
  map.addLayer({
    id: "trail-casing",
    type: "line",
    source: "trail",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#111827", "line-width": 7, "line-opacity": 0.45 },
  });
  map.addLayer({
    id: "trail-line",
    type: "line",
    source: "trail",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#60a5fa", 0.3, "#3b82f6", 0.6, "#6366f1", 0.85, "#7c3aed", 1, "#581c87"],
      "line-width": 4,
      "line-opacity": 0.9,
    },
  });
  requestAnimationFrame(() => { map.resize(); renderMap({ fit: true }); });
});
window.addEventListener("resize", () => map.resize());
new ResizeObserver(() => map.resize()).observe($("map"));

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${tokenEl.value}`, "Content-Type": "application/json" };
}

async function api<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(await res.text() || res.statusText);
  const ct = res.headers.get("content-type") || "";
  return (ct.includes("json") ? await res.json() : await res.text()) as T;
}

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function effectivePoint(entry: AdminHistoryEntry, idx: number): LonLat {
  return entry.edits.moved_points[String(idx)] || entry.breadcrumbs[idx];
}

function editedPoints(entry: AdminHistoryEntry): [number, LonLat][] {
  const hidden = new Set(entry.edits.hidden_indices || []);
  return entry.breadcrumbs.map((_, i): [number, LonLat] => [i, effectivePoint(entry, i)]).filter(([i]) => !hidden.has(i));
}

function telemetryFor(entry: AdminHistoryEntry, idx: number): BreadcrumbTelemetry | null {
  return entry.telemetry?.[idx] ?? null;
}

function accuracyClass(accuracy?: number | null): string {
  if (accuracy == null || !Number.isFinite(accuracy)) return "accuracy-unknown";
  if (accuracy <= 25) return "accuracy-good";
  if (accuracy <= 100) return "accuracy-warn";
  return "accuracy-bad";
}

function pointDetails(entry: AdminHistoryEntry, idx: number): string {
  const tel = telemetryFor(entry, idx);
  const parts = [`Point ${idx + 1}/${entry.breadcrumbs.length}`];
  if (tel?.timestamp_ms) parts.push(new Date(tel.timestamp_ms).toISOString());
  if (tel?.accuracy != null) parts.push(`±${Math.round(tel.accuracy)}m`);
  if (tel?.altitude != null) parts.push(`${Math.round(tel.altitude)}m alt`);
  if (tel?.speed != null) parts.push(`${(tel.speed * 3.6).toFixed(1)} km/h`);
  return parts.join(" · ");
}

async function load() {
  $("status").textContent = "Loading…";
  entries = await api<AdminHistoryEntry[]>(`/api/admin/history?all=${($("show-hidden") as HTMLInputElement).checked ? "true" : "false"}`);
  renderList();
  $("status").textContent = `${entries.length} entries`;
}

function renderList() {
  $("list").innerHTML = entries.map((e) => {
    const name = e.session_id || e.stream_title || e.streamer_id;
    const pts = e.edited_breadcrumbs.length;
    return `<div class="entry ${e.hidden ? "hidden" : ""} ${current?.id === e.id ? "active" : ""}" data-id="${e.id}"><div class="name">#${e.id} ${escapeHtml(name)}</div><div class="meta">${fmt(e.started_at)} · ${pts}/${e.breadcrumbs.length} pts ${e.hidden ? "· hidden" : ""} ${e.completed ? "" : "· incomplete"}</div></div>`;
  }).join("");
  document.querySelectorAll<HTMLElement>(".entry").forEach((el) => {
    el.onclick = () => selectEntry(Number(el.dataset.id));
  });
}

function selectEntry(id: number) {
  current = entries.find((e) => e.id === id) ?? null;
  selectedIndex = null;
  if (!current) return;
  ($("name") as HTMLInputElement).value = current.session_id || "";
  $("toggle-hide").textContent = current.hidden ? "Unhide entry" : "Hide entry";
  renderList();
  renderMap({ fit: true });
}

function renderMap({ fit = false } = {}) {
  markers.forEach((m) => m.remove());
  markers = [];
  const source = map.getSource("trail") as maplibregl.GeoJSONSource | undefined;
  if (!current || !source) return;

  const visible = editedPoints(current);
  const coords = visible.map(([, p]) => p);
  source.setData(coords.length >= 2 ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } : emptyFc());

  const hidden = new Set(current.edits.hidden_indices || []);
  current.breadcrumbs.forEach((_, idx) => {
    if (!current) return;
    const p = effectivePoint(current, idx);
    const tel = telemetryFor(current, idx);
    const el = document.createElement("div");
    el.className = "marker " + accuracyClass(tel?.accuracy) + (hidden.has(idx) ? " hidden-point" : "") + (current.edits.moved_points[String(idx)] ? " moved-point" : "") + (selectedIndex === idx ? " selected" : "");
    const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
    el.title = pointDetails(current, idx);
    el.onclick = (ev) => {
      ev.stopPropagation();
      selectedIndex = idx;
      if (current) $("status").textContent = pointDetails(current, idx);
      renderMap();
    };
    marker.on("dragend", () => {
      if (!current) return;
      const ll = marker.getLngLat();
      current.edits.moved_points[String(idx)] = [ll.lng, ll.lat];
      renderMap();
    });
    markers.push(marker);
  });

  if (fit && coords.length) fitTrail(coords);
}

function fitTrail(coords: LonLat[]) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    map.resize();
    const mapEl = $("map");
    const w = mapEl.clientWidth;
    const h = mapEl.clientHeight;
    if (!w || !h) return;
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const west = Math.min(...lngs), east = Math.max(...lngs);
    const south = Math.min(...lats), north = Math.max(...lats);
    const center: LonLat = [(west + east) / 2, (south + north) / 2];
    if (coords.length === 1 || (west === east && south === north)) {
      map.jumpTo({ center, zoom: Math.min(map.getMaxZoom(), 16) });
      return;
    }
    const padding = 70;
    const z = Math.min(
      zoomForLngSpan(east - west, Math.max(1, w - padding * 2)),
      zoomForLatSpan(north, south, Math.max(1, h - padding * 2)),
      16,
    );
    map.jumpTo({ center, zoom: z });
  }));
}

function zoomForLngSpan(lngSpan: number, px: number): number {
  return Math.log2((360 * px) / (Math.max(lngSpan, 0.00001) * 512));
}
function latToMercator(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const rad = clamped * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}
function zoomForLatSpan(north: number, south: number, px: number): number {
  const span = Math.abs(latToMercator(north) - latToMercator(south));
  return Math.log2(px / (Math.max(span, 0.0000001) * 512));
}

function selectedPointIndex(): number | null {
  if (selectedIndex == null) {
    alert("Select a point first");
    return null;
  }
  return selectedIndex;
}

$("load").onclick = () => load().catch((err) => $("status").textContent = err.message);
$("show-hidden").onchange = () => load().catch((err) => $("status").textContent = err.message);
$("rename").onclick = async () => {
  if (!current) return;
  const name = ($("name") as HTMLInputElement).value || null;
  await api<string>(`/api/admin/history/${current.id}`, { method: "PATCH", body: JSON.stringify({ session_id: name }) });
  current.session_id = name;
  renderList();
};
$("toggle-hide").onclick = async () => {
  if (!current) return;
  const hidden = !current.hidden;
  await api<string>(`/api/admin/history/${current.id}`, { method: "PATCH", body: JSON.stringify({ hidden }) });
  current.hidden = hidden;
  $("toggle-hide").textContent = hidden ? "Unhide entry" : "Hide entry";
  renderList();
};
$("delete-entry").onclick = async () => {
  if (!current || !confirm(`Permanently delete entry #${current.id}?`)) return;
  await api<string>(`/api/admin/history/${current.id}`, { method: "DELETE" });
  entries = entries.filter((e) => e.id !== current?.id);
  current = null;
  renderList();
  renderMap();
};
$("hide-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  if (!current.edits.hidden_indices.includes(idx)) current.edits.hidden_indices.push(idx);
  renderMap();
};
$("unhide-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  current.edits.hidden_indices = current.edits.hidden_indices.filter((i) => i !== idx);
  renderMap();
};
$("reset-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  delete current.edits.moved_points[String(idx)];
  renderMap();
};
$("discard-edits").onclick = () => {
  if (!current || !confirm("Discard all saved GPS edits for this entry? Original breadcrumbs will be restored.")) return;
  current.edits = { hidden_indices: [], moved_points: {} };
  selectedIndex = null;
  renderMap();
};
$("hide-low-accuracy").onclick = () => {
  if (!current) return;
  const threshold = Number.parseFloat(($("accuracy-threshold") as HTMLInputElement).value);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    alert("Enter a positive accuracy threshold in meters");
    return;
  }
  const toHide = (current.telemetry ?? [])
    .map((tel, idx) => ({ idx, accuracy: tel.accuracy }))
    .filter(({ accuracy }) => accuracy != null && accuracy > threshold)
    .map(({ idx }) => idx);
  const hidden = new Set(current.edits.hidden_indices);
  toHide.forEach((idx) => hidden.add(idx));
  current.edits.hidden_indices = [...hidden].sort((a, b) => a - b);
  $("status").textContent = `Marked ${toHide.length} points with accuracy > ${threshold}m hidden`;
  renderMap();
};
$("save-edits").onclick = async () => {
  if (!current) return;
  current.edits.hidden_indices.sort((a, b) => a - b);
  await api<string>(`/api/admin/history/${current.id}/edits`, { method: "PUT", body: JSON.stringify(current.edits) });
  $("status").textContent = "Saved GPS edits";
  current.edited_breadcrumbs = editedPoints(current).map(([, p]) => p);
  renderList();
};

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

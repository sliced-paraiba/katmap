import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./admin-history.css";
import { Theme, RASTER_STYLE, applyTheme, isTheme, registerPmtiles } from "./themes";
import { escapeHtml } from "./html";
import type { AdminHistoryEntry } from "./api-types";
import type { LonLat } from "./geo";
import type { BreadcrumbPoint } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenEl = $("token") as HTMLInputElement;
tokenEl.value = localStorage.getItem("katmap-admin-token") || "";
tokenEl.addEventListener("input", () => localStorage.setItem("katmap-admin-token", tokenEl.value));

let entries: AdminHistoryEntry[] = [];
let current: AdminHistoryEntry | null = null;
let selectedIndex: number | null = null;
let markers: maplibregl.Marker[] = [];
let undoStack: AdminHistoryEntry["edits"][] = [];

registerPmtiles();

const map = new maplibregl.Map({
  container: "map",
  style: RASTER_STYLE,
  center: [-122.3321, 47.6062],
  zoom: 12,
  dragRotate: false,
});

map.addControl(new maplibregl.NavigationControl());

function addCustomLayers() {
  if (!map.getSource("trail")) {
    map.addSource("trail", { type: "geojson", lineMetrics: true, data: emptyFc() });
  }
  if (!map.getLayer("trail-casing")) {
    map.addLayer({
      id: "trail-casing",
      type: "line",
      source: "trail",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#111827", "line-width": 7, "line-opacity": 0.45 },
    });
  }
  if (!map.getLayer("trail-line")) {
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
  }
}

map.on("style.load", addCustomLayers);

// Load the stored theme
const STORAGE_KEY = "katmap-admin-theme";
const themeSelect = $("theme-select") as HTMLSelectElement;

function loadStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isTheme(stored)) return stored;
  } catch { /* ignore */ }
  return "dark";
}

const initialTheme = loadStoredTheme();
themeSelect.value = initialTheme;

themeSelect.addEventListener("change", () => {
  const theme = themeSelect.value as Theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  applyTheme(map, theme, () => {
    addCustomLayers();
    if (current) renderMap({ fit: true });
  });
});

// Apply initial theme
map.once("load", () => {
  applyTheme(map, initialTheme, () => {
    addCustomLayers();
    requestAnimationFrame(() => { map.resize(); if (current) renderMap({ fit: true }); });
  });
});
window.addEventListener("resize", () => map.resize());
new ResizeObserver(() => map.resize()).observe($("map"));
map.on("click", (e) => {
  if (!current) return;
  const features = map.queryRenderedFeatures(e.point, { layers: ["trail-line", "trail-casing"] });
  if (features.length === 0) return;
  selectNearestVisiblePoint(e.point);
});

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

function telemetryFor(entry: AdminHistoryEntry, idx: number): BreadcrumbPoint | null {
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
  const point = effectivePoint(entry, idx);
  const parts = [`Point ${idx + 1}/${entry.breadcrumbs.length}`, `${point[1].toFixed(6)}, ${point[0].toFixed(6)}`];
  if (tel?.timestamp_ms) parts.push(new Date(tel.timestamp_ms).toISOString());
  if (tel?.accuracy != null) parts.push(`±${Math.round(tel.accuracy)}m`);
  if (tel?.altitude != null) parts.push(`${Math.round(tel.altitude)}m alt`);
  if (tel?.speed != null) parts.push(`${(tel.speed * 3.6).toFixed(1)} km/h`);
  if (entry.edits.hidden_indices.includes(idx)) parts.push("hidden");
  if (entry.edits.moved_points[String(idx)]) parts.push("moved");
  return parts.join(" · ");
}

function cloneEdits(entry: AdminHistoryEntry): AdminHistoryEntry["edits"] {
  return {
    hidden_indices: [...entry.edits.hidden_indices],
    moved_points: Object.fromEntries(Object.entries(entry.edits.moved_points).map(([k, v]) => [k, [...v] as LonLat])),
    updated_at: entry.edits.updated_at,
    updated_by: entry.edits.updated_by,
  };
}

function pushUndo() {
  if (current) undoStack.push(cloneEdits(current));
}

function undoEdit() {
  if (!current) return;
  const previous = undoStack.pop();
  if (!previous) {
    $("status").textContent = "No local edits to undo";
    return;
  }
  current.edits = previous;
  selectedIndex = null;
  $("status").textContent = `Undid local edit (${undoStack.length} undo step${undoStack.length === 1 ? "" : "s"} left)`;
  renderMap();
}

function selectPoint(idx: number) {
  if (!current) return;
  selectedIndex = idx;
  ($("range-start") as HTMLInputElement).value = String(idx + 1);
  ($("range-end") as HTMLInputElement).value = String(idx + 1);
  $("status").textContent = pointDetails(current, idx);
  renderMap();
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
  undoStack = [];
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
      selectPoint(idx);
    };
    marker.on("dragend", () => {
      if (!current) return;
      pushUndo();
      const ll = marker.getLngLat();
      current.edits.moved_points[String(idx)] = [ll.lng, ll.lat];
      selectPoint(idx);
    });
    markers.push(marker);
  });

  if (fit && coords.length) fitTrail(coords);
}

function selectNearestVisiblePoint(point: { x: number; y: number }) {
  if (!current) return;
  const visible = editedPoints(current);
  if (!visible.length) return;
  let best = visible[0][0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [idx, coord] of visible) {
    const projected = map.project(coord);
    const dx = projected.x - point.x;
    const dy = projected.y - point.y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = idx;
    }
  }
  if (bestDist <= 48) selectPoint(best);
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
  if (!current || !confirm(`Hide entry #${current.id}? This is a soft delete; the original row remains in the DB and can be shown again with “Show hidden entries”.`)) return;
  await api<string>(`/api/admin/history/${current.id}`, { method: "DELETE" });
  current.hidden = true;
  if (!(($("show-hidden") as HTMLInputElement).checked)) {
    entries = entries.filter((e) => e.id !== current?.id);
    current = null;
  }
  renderList();
  renderMap();
};
$("hide-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  pushUndo();
  if (!current.edits.hidden_indices.includes(idx)) current.edits.hidden_indices.push(idx);
  renderMap();
};
$("unhide-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  pushUndo();
  current.edits.hidden_indices = current.edits.hidden_indices.filter((i) => i !== idx);
  renderMap();
};
$("reset-point").onclick = () => {
  if (!current) return;
  const idx = selectedPointIndex();
  if (idx == null) return;
  pushUndo();
  delete current.edits.moved_points[String(idx)];
  renderMap();
};
$("hide-range").onclick = () => {
  if (!current) return;
  const start = Number.parseInt(($("range-start") as HTMLInputElement).value, 10);
  const end = Number.parseInt(($("range-end") as HTMLInputElement).value, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    alert("Enter a start and end point number");
    return;
  }
  const lo = Math.max(1, Math.min(start, end));
  const hi = Math.min(current.breadcrumbs.length, Math.max(start, end));
  if (lo > hi) return;
  pushUndo();
  const hidden = new Set(current.edits.hidden_indices);
  for (let pointNo = lo; pointNo <= hi; pointNo++) hidden.add(pointNo - 1);
  current.edits.hidden_indices = [...hidden].sort((a, b) => a - b);
  selectedIndex = null;
  $("status").textContent = `Marked points ${lo}–${hi} hidden`;
  renderMap();
};
$("undo-edit").onclick = undoEdit;
$("discard-edits").onclick = () => {
  if (!current || !confirm("Discard all saved GPS edits for this entry? Original breadcrumbs will be restored.")) return;
  pushUndo();
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
  pushUndo();
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
  undoStack = [];
  $("status").textContent = "Saved GPS edits";
  current.edited_breadcrumbs = editedPoints(current).map(([, p]) => p);
  renderList();
};

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}

document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    ($("save-edits") as HTMLButtonElement).click();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    undoEdit();
    return;
  }
  if (isTypingTarget(ev.target)) return;
  if (ev.key === "Delete" || ev.key === "Backspace") {
    ev.preventDefault();
    ($("hide-point") as HTMLButtonElement).click();
  } else if (ev.key === "Escape") {
    selectedIndex = null;
    ($("status") as HTMLElement).textContent = current ? "Deselected point" : "No entry selected";
    renderMap();
  }
});

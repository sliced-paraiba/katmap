import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { AppState } from "./state";
import { ClientMessage, Waypoint } from "./types";

// Seattle center as ultimate fallback
const DEFAULT_CENTER: [number, number] = [-122.3321, 47.6062];

const TILES_BASE = (window.location.origin ?? "") + "/tiles";

// Raster fallback style (used when PMTiles haven't loaded yet or as a fallback)
const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [
    {
      id: "osm-tiles",
      type: "raster",
      source: "osm",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

export type Theme = "dark" | "light" | "bright" | "fiord" | "toner" | "basic" | "neon" | "midnight" | "raster";

const THEME_FILE: Record<Exclude<Theme, "raster">, string> = {
  dark:     "dark-matter",
  light:    "positron",
  bright:   "osm-bright",
  fiord:    "fiord-color",
  toner:    "toner",
  basic:    "basic",
  neon:     "neon-night",
  midnight: "midnight-blue",
};

// Fetch a vector style JSON from the tile server
async function fetchStyle(theme: Exclude<Theme, "raster">): Promise<maplibregl.StyleSpecification | null> {
  const name = THEME_FILE[theme];
  try {
    const resp = await fetch(`${TILES_BASE}/${name}.json`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

interface ContextMenuTarget {
  lat: number;
  lon: number;
  waypoint: Waypoint | null;
}

export class MapView {
  private map: maplibregl.Map;
  private markers: Map<string, maplibregl.Marker> = new Map();
  private streamerMarker: maplibregl.Marker | null = null;
  private onSend: (msg: ClientMessage) => void;
  private state: AppState;
  private hasCenteredOnStreamer = false;
  private contextMenu: HTMLElement;
  private currentTheme: Theme = "dark";
  private onThemeChange: (theme: Theme) => void;
  private initialTheme: Theme;
  private followStreamer: boolean = false;
  private onFollowChange: (following: boolean) => void;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;

  constructor(
    container: string | HTMLElement,
    state: AppState,
    onSend: (msg: ClientMessage) => void,
    onThemeChange: (theme: Theme) => void,
    initialTheme: Theme = "dark",
    onFollowChange: (following: boolean) => void = () => {}
  ) {
    this.state = state;
    this.onSend = onSend;
    this.onThemeChange = onThemeChange;
    this.initialTheme = initialTheme;
    this.onFollowChange = onFollowChange;

    // Register PMTiles protocol globally
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    this.map = new maplibregl.Map({
      container,
      style: RASTER_STYLE,
      center: DEFAULT_CENTER,
      zoom: 12,
      dragRotate: false,
    });

    this.map.addControl(new maplibregl.NavigationControl(), "top-right");

    // Build context menu element
    this.contextMenu = this.buildContextMenu();
    document.body.appendChild(this.contextMenu);

    // Right-click on map → show context menu
    this.map.on("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(
        { lat: e.lngLat.lat, lon: e.lngLat.lng, waypoint: null },
        e.originalEvent.clientX,
        e.originalEvent.clientY
      );
    });

    // Long-press on map → show context menu (mobile-friendly)
    const mapCanvas = this.map.getCanvas();
    mapCanvas.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      this.longPressFired = false;
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      this.longPressTimer = setTimeout(() => {
        this.longPressFired = true;
        const lngLat = this.map.unproject([startX - mapCanvas.getBoundingClientRect().left, startY - mapCanvas.getBoundingClientRect().top]);
        this.showContextMenu(
          { lat: lngLat.lat, lon: lngLat.lng, waypoint: null },
          startX,
          startY
        );
      }, 500);

      // Cancel if finger moves too far (> 10px = drag, not long-press)
      const onTouchMove = (me: TouchEvent) => {
        const t = me.touches[0];
        if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
          this.cancelLongPress();
          mapCanvas.removeEventListener("touchmove", onTouchMove);
        }
      };
      mapCanvas.addEventListener("touchmove", onTouchMove, { passive: true });
    }, { passive: true });

    mapCanvas.addEventListener("touchend", () => {
      this.cancelLongPress();
    }, { passive: true });

    mapCanvas.addEventListener("touchcancel", () => {
      this.cancelLongPress();
    }, { passive: true });

    // Dismiss context menu on left-click / tap (but not if long-press just fired)
    this.map.on("click", () => {
      if (this.longPressFired) {
        this.longPressFired = false;
        return;
      }
      this.hideContextMenu();
    });
    document.addEventListener("click", () => this.hideContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideContextMenu();
    });

    // Add custom layers once the initial style is fully loaded
    this.map.on("load", () => {
      this.setTheme(this.initialTheme);
    });

    // Re-add custom layers every time a style fully loads (initial + after setStyle).
    // Using style.load (not styledata) so the vector tile layers are already in place
    // and our custom layers end up correctly on top.
    this.map.on("style.load", () => {
      this.addRouteLayer();
    });

    state.subscribe(() => this.update());

    // Auto-disable follow on manual pan
    this.map.on("dragstart", () => {
      if (this.followStreamer) {
        this.followStreamer = false;
        this.onFollowChange(false);
      }
    });
  }

  private addRouteLayer() {
    // Remove any partially-added sources/layers from a previous aborted call
    // before re-adding, so we don't throw "already exists".
    if (!this.map.getSource("breadcrumbs")) {
      this.map.addSource("breadcrumbs", {
        type: "geojson",
        lineMetrics: true,
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer("breadcrumb-line-casing")) {
      this.map.addLayer({
        id: "breadcrumb-line-casing",
        type: "line",
        source: "breadcrumbs",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#111827",
          "line-width": 7,
          "line-opacity": 0.45,
        },
      });
    }
    if (!this.map.getLayer("breadcrumb-line")) {
      this.map.addLayer({
        id: "breadcrumb-line",
        type: "line",
        source: "breadcrumbs",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-gradient": trailGradientExpression(),
          "line-width": 4,
          "line-opacity": 0.95,
        },
      });
    }
    if (!this.map.getSource("breadcrumb-endpoints")) {
      this.map.addSource("breadcrumb-endpoints", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer("breadcrumb-endpoint-halo")) {
      this.map.addLayer({
        id: "breadcrumb-endpoint-halo",
        type: "circle",
        source: "breadcrumb-endpoints",
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": ["case", ["==", ["get", "kind"], "end"], 9, 8],
          "circle-opacity": 0.9,
        },
      });
    }
    if (!this.map.getLayer("breadcrumb-endpoint")) {
      this.map.addLayer({
        id: "breadcrumb-endpoint",
        type: "circle",
        source: "breadcrumb-endpoints",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["case", ["==", ["get", "kind"], "end"], 6, 5],
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 1.5,
        },
      });
    }

    if (!this.map.getSource("history-trail")) {
      this.map.addSource("history-trail", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer("history-trail-line")) {
      this.map.addLayer({
        id: "history-trail-line",
        type: "line",
        source: "history-trail",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#3b82f6",
          "line-width": 3,
          "line-opacity": 0.75,
          "line-dasharray": [2, 1],
        },
      });
    }

    if (!this.map.getSource("route")) {
      this.map.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer("route-line")) {
      this.map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#0f9b8e",
          "line-width": 4,
          "line-opacity": 0.8,
        },
      });
    }

    // Keep breadcrumb endpoint dots above route/history lines so start/end stay visible.
    if (this.map.getLayer("breadcrumb-endpoint-halo")) this.map.moveLayer("breadcrumb-endpoint-halo");
    if (this.map.getLayer("breadcrumb-endpoint")) this.map.moveLayer("breadcrumb-endpoint");

    // Re-populate from state in case data arrived before this style loaded
    this.updateRouteLine();
    this.updateBreadcrumbs();
    this.updateHistoryTrail();
    console.debug("[map] addRouteLayer: sources/layers ready, breadcrumb coords:", this.state.breadcrumbCoords.length);
  }

  async setTheme(theme: Theme) {
    if (theme === this.currentTheme && theme !== "raster") return;

    this.currentTheme = theme;
    this.onThemeChange(theme);

    if (theme === "raster") {
      this.map.setStyle(RASTER_STYLE);
      return;
    }

    const style = await fetchStyle(theme);
    if (!style) {
      // PMTiles not ready yet — fall back to raster silently
      if (this.currentTheme === theme) {
        this.currentTheme = "raster";
        this.onThemeChange("raster");
        this.map.setStyle(RASTER_STYLE);
      }
      return;
    }

    this.map.setStyle(style as maplibregl.StyleSpecification);
  }

  getTheme(): Theme {
    return this.currentTheme;
  }

  setFollow(on: boolean) {
    this.followStreamer = on;
    this.onFollowChange(on);
    if (on) {
      const loc = this.state.location;
      if (loc) {
        this.map.easeTo({ center: [loc.lon, loc.lat], duration: 500 });
      }
    }
  }

  getFollow(): boolean {
    return this.followStreamer;
  }

  // --- Context menu ---

  private buildContextMenu(): HTMLElement {
    const el = document.createElement("div");
    el.id = "map-context-menu";
    el.className = "context-menu";
    el.style.display = "none";
    el.addEventListener("click", (e) => e.stopPropagation());
    return el;
  }

  private setMapInteractive(enabled: boolean) {
    const m = this.map;
    if (enabled) {
      m.dragPan.enable();
      m.scrollZoom.enable();
      m.touchZoomRotate.enable();
      m.doubleClickZoom.enable();
    } else {
      m.dragPan.disable();
      m.scrollZoom.disable();
      m.touchZoomRotate.disable();
      m.doubleClickZoom.disable();
    }
  }

  private showContextMenu(target: ContextMenuTarget, x: number, y: number) {
    const menu = this.contextMenu;
    menu.innerHTML = "";

    if (target.waypoint) {
      const wp = target.waypoint;
      const allIds = this.state.waypoints.map((w) => w.id);
      const isFirst = allIds[0] === wp.id;
      const isLast = allIds[allIds.length - 1] === wp.id;

      if (!isFirst) {
        this.addMenuItem(menu, "Set as start", () => {
          const ordered = [wp.id, ...allIds.filter((id) => id !== wp.id)];
          this.onSend({ type: "reorder_waypoints", ordered_ids: ordered });
        });
      }
      if (!isLast) {
        this.addMenuItem(menu, "Set as end", () => {
          const ordered = [...allIds.filter((id) => id !== wp.id), wp.id];
          this.onSend({ type: "reorder_waypoints", ordered_ids: ordered });
        });
      }
      this.addMenuSeparator(menu);
      this.addMenuItem(menu, "Open in Google Maps", () => {
        window.open(`https://www.google.com/maps?q=${wp.lat},${wp.lon}`, "_blank");
      });
      this.addMenuSeparator(menu);
      this.addMenuItem(menu, "Delete node", () => {
        this.onSend({ type: "remove_waypoint", id: wp.id });
      }, true);
    } else {
      this.addMenuItem(menu, "Add waypoint here", async () => {
        const { lat, lon } = target;
        const label =
          (await reverseGeocode(lat, lon)) ??
          `Stop ${this.state.waypoints.length + 1}`;
        this.onSend({ type: "add_waypoint", lat, lon, label });
      });
      this.addMenuSeparator(menu);
      this.addMenuItem(menu, "Open in Google Maps", () => {
        window.open(`https://www.google.com/maps?q=${target.lat},${target.lon}`, "_blank");
      });
    }

    menu.style.display = "block";
    this.setMapInteractive(false);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    requestAnimationFrame(() => {
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      menu.style.left = `${Math.min(x, vw - mw - 8)}px`;
      menu.style.top = `${Math.min(y, vh - mh - 8)}px`;
    });
  }

  private hideContextMenu() {
    this.contextMenu.style.display = "none";
    this.setMapInteractive(true);
  }

  private cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private addMenuItem(menu: HTMLElement, label: string, action: () => void, danger = false) {
    const item = document.createElement("div");
    item.className = "context-menu-item" + (danger ? " context-menu-danger" : "");
    item.textContent = label;
    item.addEventListener("click", () => {
      this.hideContextMenu();
      action();
    });
    menu.appendChild(item);
  }

  private addMenuSeparator(menu: HTMLElement) {
    const sep = document.createElement("div");
    sep.className = "context-menu-separator";
    menu.appendChild(sep);
  }

  // --- State update ---

  private update() {
    this.updateWaypointMarkers();
    this.updateStreamerMarker();
    this.updateRouteLine();
    this.updateBreadcrumbs();
    this.updateHistoryTrail();
  }

  private updateWaypointMarkers() {
    const currentIds = new Set(this.state.waypoints.map((w) => w.id));

    for (const [id, marker] of this.markers) {
      if (!currentIds.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }

    this.state.waypoints.forEach((wp, index) => {
      const existing = this.markers.get(wp.id);
      if (existing) {
        existing.setLngLat([wp.lon, wp.lat]);
        const el = existing.getElement();
        const label = el.querySelector(".marker-label");
        if (label) label.textContent = String(index + 1);
      } else {
        this.createWaypointMarker(wp, index);
      }
    });
  }

  private createWaypointMarker(wp: Waypoint, index: number) {
    const el = document.createElement("div");
    el.className = "waypoint-marker";
    el.innerHTML = `<span class="marker-label">${index + 1}</span>`;
    el.style.cssText = `
      width: 28px; height: 28px; border-radius: 50%;
      background: #0f9b8e; border: 2px solid #fff;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 12px; font-weight: 700;
      cursor: grab; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    `;

    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([wp.lon, wp.lat])
      .addTo(this.map);

    marker.on("dragend", () => {
      const lngLat = marker.getLngLat();
      this.onSend({ type: "move_waypoint", id: wp.id, lat: lngLat.lat, lon: lngLat.lng });
    });

    // Show context menu on click (mobile tap) and right-click (desktop)
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const currentWp = this.state.waypoints.find((w) => w.id === wp.id);
      if (!currentWp) return;
      const lngLat = marker.getLngLat();
      this.showContextMenu(
        { lat: lngLat.lat, lon: lngLat.lng, waypoint: currentWp },
        e.clientX,
        e.clientY
      );
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWp = this.state.waypoints.find((w) => w.id === wp.id);
      if (!currentWp) return;
      const lngLat = marker.getLngLat();
      this.showContextMenu(
        { lat: lngLat.lat, lon: lngLat.lng, waypoint: currentWp },
        e.clientX,
        e.clientY
      );
    });

    this.markers.set(wp.id, marker);
  }

  private updateStreamerMarker() {
    const loc = this.state.location;
    if (!loc) return;

    if (!this.hasCenteredOnStreamer) {
      this.hasCenteredOnStreamer = true;
      this.map.flyTo({ center: [loc.lon, loc.lat], zoom: 13, duration: 1500 });
    } else if (this.followStreamer) {
      this.map.easeTo({ center: [loc.lon, loc.lat], duration: 500 });
    }

    const displayName = loc.display_name ?? null;
    const heading = loc.heading;
    const speed = loc.speed;

    if (!this.streamerMarker) {
      const el = this.buildStreamerElement(displayName, heading, speed);
      this.streamerMarker = new maplibregl.Marker({ element: el })
        .setLngLat([loc.lon, loc.lat])
        .addTo(this.map);
    } else {
      this.streamerMarker.setLngLat([loc.lon, loc.lat]);
      this.updateStreamerHeading(heading, speed);
    }
  }

  private updateStreamerHeading(heading: number | null | undefined, speed: number | null | undefined) {
    const arrow = this.streamerMarker?.getElement().querySelector(".streamer-heading-arrow") as HTMLElement | null;
    if (!arrow) return;
    if (heading != null && speed != null && speed > 0) {
      arrow.style.display = "block";
      arrow.style.transform = `rotate(${heading}deg)`;
    } else {
      arrow.style.display = "none";
    }
  }

  private buildStreamerElement(displayName: string | null, heading: number | null | undefined, speed: number | null | undefined): HTMLElement {
    // Wrapper — no overflow clipping so the arrow can extend outside
    const wrapper = document.createElement("div");
    wrapper.className = "streamer-marker";

    if (displayName) {
      const avatarUrl = `/api/avatar`;
      wrapper.style.cssText = `
        width: 40px; height: 40px; border-radius: 50%;
        border: 3px solid #fff;
        box-shadow: 0 0 8px rgba(0,0,0,0.5);
        background: #1a1a2e url("${avatarUrl}") center/cover no-repeat;
      `;
    } else {
      wrapper.style.cssText = `
        width: 18px; height: 18px; border-radius: 50%;
        background: #e74c3c; border: 3px solid #fff;
        box-shadow: 0 0 8px rgba(231,76,60,0.6);
      `;
    }

    // Heading arrow — sits outside the circle, rotated to indicate direction
    const arrow = document.createElement("div");
    arrow.className = "streamer-heading-arrow";
    if (heading != null && speed != null && speed > 0) {
      arrow.style.transform = `rotate(${heading}deg)`;
    } else {
      arrow.style.display = "none";
    }
    wrapper.appendChild(arrow);

    return wrapper;
  }

  private updateRouteLine() {
    const route = this.state.route;
    if (!this.map.getSource("route")) return;

    const source = this.map.getSource("route") as maplibregl.GeoJSONSource;
    if (!route) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const coords = decodePolyline(route.polyline);
    source.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    });
  }

  private updateBreadcrumbs() {
    if (!this.map.getSource("breadcrumbs")) {
      console.debug("[map] updateBreadcrumbs: source not ready, coords:", this.state.breadcrumbCoords.length);
      return;
    }
    const source = this.map.getSource("breadcrumbs") as maplibregl.GeoJSONSource;
    const endpointSource = this.map.getSource("breadcrumb-endpoints") as maplibregl.GeoJSONSource | undefined;
    const coords = this.state.breadcrumbCoords;
    console.debug("[map] updateBreadcrumbs: setting", coords.length, "coords");
    if (coords.length < 2) {
      source.setData({ type: "FeatureCollection", features: [] });
      endpointSource?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    source.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    });
    endpointSource?.setData(trailEndpointFeatureCollection(coords));
  }

  private updateHistoryTrail() {
    if (!this.map.getSource("history-trail")) return;
    const source = this.map.getSource("history-trail") as maplibregl.GeoJSONSource;
    const coords = this.state.historyTrail;
    if (coords.length < 2) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    source.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    });
  }

  getMap(): maplibregl.Map {
    return this.map;
  }
}

/**
 * Reverse geocode a lat/lon via Nominatim.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "KatMap/1.0" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const addr = data.address;
    if (!addr) return null;
    if (data.place_rank < 26) return null;
    const road = addr.road ?? addr.pedestrian ?? addr.footway ?? addr.path ?? addr.cycleway;
    if (!road) return null;
    const houseNumber = addr.house_number;
    return houseNumber ? `${houseNumber} ${road}` : road;
  } catch {
    return null;
  }
}

function trailGradientExpression(): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["line-progress"],
    0,
    "#2563eb", // start: blue
    0.2,
    "#06b6d4",
    0.4,
    "#22c55e",
    0.6,
    "#facc15",
    0.8,
    "#f97316",
    1,
    "#ef4444", // end: red
  ] as maplibregl.ExpressionSpecification;
}

function trailEndpointFeatureCollection(coords: [number, number][]) {
  const start = coords[0];
  const end = coords[coords.length - 1];

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "start", color: "#2563eb" },
        geometry: { type: "Point" as const, coordinates: start },
      },
      {
        type: "Feature" as const,
        properties: { kind: "end", color: "#ef4444" },
        geometry: { type: "Point" as const, coordinates: end },
      },
    ],
  };
}

// Decode Valhalla precision-6 encoded polyline
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / 1e6, lat / 1e6]);
  }

  return coords;
}

/**
 * Shared theme support for all pages.
 *
 * Each page imports this module to fetch ProtoMap-compatible vector styles
 * from the tile server, with raster fallback.
 */
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

export const THEMES = ["dark", "light", "bright", "fiord", "toner", "basic", "neon", "midnight", "raster"] as const;
export type Theme = typeof THEMES[number];

const TILES_BASE = (window.location.origin ?? "") + "/tiles";

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

export const RASTER_STYLE: maplibregl.StyleSpecification = {
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

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

export function themeFile(theme: Exclude<Theme, "raster">): string {
  return THEME_FILE[theme];
}

/** Fetch a vector style JSON from the tile server. Returns null on failure. */
export async function fetchStyle(theme: Exclude<Theme, "raster">): Promise<maplibregl.StyleSpecification | null> {
  const name = THEME_FILE[theme];
  try {
    const resp = await fetch(`${TILES_BASE}/${name}.json`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Apply a theme to a MapLibre map instance.
 * Tries the vector style; falls back to raster on failure.
 * Calls `onLoad` after the style is fully loaded (both `style.load` and source data).
 */
export async function applyTheme(
  map: maplibregl.Map,
  theme: Theme,
  onLoad?: () => void,
): Promise<void> {
  if (theme === "raster") {
    map.setStyle(RASTER_STYLE);
    if (onLoad) map.once("style.load", onLoad);
    return;
  }

  const style = await fetchStyle(theme);
  if (style) {
    map.setStyle(style);
    if (onLoad) map.once("style.load", onLoad);
  } else {
    console.warn(`[theme] Failed to fetch "${theme}" style, falling back to raster`);
    map.setStyle(RASTER_STYLE);
    if (onLoad) map.once("style.load", onLoad);
  }
}

/**
 * Register the PMTiles protocol globally.
 * Safe to call multiple times — Protocol is a singleton.
 */
export function registerPmtiles(): void {
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
}

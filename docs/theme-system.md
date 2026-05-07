# Theme System

Map themes are centralized in `client/src/themes.ts` and managed through a `SettingsPopup` in `client/src/settings.ts`. Adding a new theme requires changes in one file only.

## How Themes Work

The `THEMES` const in `themes.ts` defines all available themes:

```typescript
export const THEMES = ["dark", "light", "bright", "fiord", "toner", "basic", "neon", "midnight", "raster"] as const;
export type Theme = typeof THEMES[number];
```

Each vector theme maps to a style JSON filename via `THEME_FILE`:

```typescript
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
```

The `"raster"` theme uses OpenStreetMap raster tiles and is defined inline as `RASTER_STYLE`.

## Adding a New Theme

Add a single entry to `client/src/themes.ts`:

1. Add the theme's short name to the `THEMES` array
2. Add an entry in `THEME_FILE` mapping it to the style JSON filename (without `.json`)
3. Add a display name in `client/src/strings.ts` under `themes`:

```typescript
themes: {
  // ... existing themes ...
  "your-theme": "Your Theme Display Name",
},
```

That's it — the `SettingsPopup` automatically renders all themes from the `THEMES` array and `strings.themes` labels.

## Theme Application

`applyTheme()` in `themes.ts` handles fetching and applying styles:

```typescript
export async function applyTheme(
  map: maplibregl.Map,
  theme: Theme,
  onLoad?: () => void,
): Promise<void>
```

- For vector themes: fetches the style JSON from `/tiles/{filename}.json`
- Falls back to raster on network failure
- Calls `onLoad` after `style.load` fires (so custom layers/markers can be re-added)

## Theme Persistence

The active theme is saved to `localStorage` under `katmap-theme` and restored on page load. The `SettingsPopup` initializes its `<select>` from this value, falling back to `"dark"`.

## PMTiles Protocol

`registerPmtiles()` in `themes.ts` registers the `pmtiles://` protocol globally via the `pmtiles` library. It's safe to call multiple times (the `Protocol` class is a singleton).

## Style JSON URLs

Each style JSON on the tile server must reference three URLs:

| Field | Example URL |
|---|---|
| `sources.openmaptiles.url` | `pmtiles://https://katmap.awawawa.mov/tiles/wa-ca.pmtiles` |
| `glyphs` | `https://katmap.awawawa.mov/tiles/fonts/{fontstack}/{range}.pbf` |
| `sprite` | `https://katmap.awawawa.mov/tiles/sprites/{sprite-name}` |

If you rename the PMTiles file, update all 8 style JSONs:
```bash
cd /srv/katmap-tiles
sed -i 's|old-name.pmtiles|new-name.pmtiles|g' *.json
```

## Style Replacement Gotcha

When the map theme changes, `map.setStyle()` removes **all** custom sources and layers. The `onLoad` callback passed to `applyTheme()` is where custom layers (route polyline, trail lines) and markers are re-added. Any new custom layer must be added in that callback.

## Multiple Pages

The theme module is shared across all pages:
- **Main app** (`main.ts`): uses `applyTheme` + `SettingsPopup`
- **Admin history** (`admin-history.ts`): uses `applyTheme` directly
- **OBS Overlay** (`overlay.ts`): reads `?theme=` query param, uses `applyTheme`

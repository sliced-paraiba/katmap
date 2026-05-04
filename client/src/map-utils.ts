import maplibregl from "maplibre-gl";
import type { LonLat } from "./geo";

export function markerElement(className: string, baseClass = "marker"): HTMLElement {
  const el = document.createElement("div");
  el.className = `${baseClass} ${className}`;
  return el;
}

export function fitCoords(
  map: maplibregl.Map,
  coords: LonLat[],
  options: maplibregl.FitBoundsOptions = {},
): void {
  if (!coords.length) return;
  requestAnimationFrame(() => {
    map.resize();
    if (coords.length === 1) {
      map.jumpTo({ center: coords[0], zoom: options.maxZoom ?? 16 });
      return;
    }
    const bounds = coords.reduce(
      (b, coord) => b.extend(coord),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    );
    map.fitBounds(bounds, options);
  });
}

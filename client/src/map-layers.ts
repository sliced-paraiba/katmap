import maplibregl from "maplibre-gl";
import type { LonLat } from "./geo";

export function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function lineStringFeature(coords: LonLat[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  };
}

export function ensureGeoJsonSource(
  map: maplibregl.Map,
  id: string,
  options: { lineMetrics?: boolean } = {},
): maplibregl.GeoJSONSource | undefined {
  if (!map.getSource(id)) {
    map.addSource(id, {
      type: "geojson",
      lineMetrics: options.lineMetrics,
      data: emptyFeatureCollection(),
    });
  }
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

export function ensureLayer(map: maplibregl.Map, layer: maplibregl.LayerSpecification) {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer);
  }
}

export function moveLayersToTop(map: maplibregl.Map, ids: string[]) {
  for (const id of ids) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

export function setGeoJsonData(
  map: maplibregl.Map,
  sourceId: string,
  data: GeoJSON.FeatureCollection | GeoJSON.Feature,
): boolean {
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  if (!source) return false;
  source.setData(data);
  return true;
}

export function setLineString(
  map: maplibregl.Map,
  sourceId: string,
  coords: LonLat[],
  options: { minPoints?: number } = {},
): boolean {
  const minPoints = options.minPoints ?? 2;
  return setGeoJsonData(
    map,
    sourceId,
    coords.length >= minPoints ? lineStringFeature(coords) : emptyFeatureCollection(),
  );
}

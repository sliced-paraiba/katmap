import type maplibregl from "maplibre-gl";
import { LonLat } from "./geo";

export function warmGradientExpression(): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["line-progress"],
    0,
    "#fbbf24",
    0.3,
    "#f97316",
    0.6,
    "#ef4444",
    0.85,
    "#dc2626",
    1,
    "#991b1b",
  ] as maplibregl.ExpressionSpecification;
}

export function coldGradientExpression(): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["line-progress"],
    0,
    "#60a5fa",
    0.3,
    "#3b82f6",
    0.6,
    "#6366f1",
    0.85,
    "#7c3aed",
    1,
    "#581c87",
  ] as maplibregl.ExpressionSpecification;
}

export function warmEndpointFeatureCollection(coords: LonLat[]): GeoJSON.FeatureCollection {
  return endpointFeatureCollection(coords, "#fbbf24", "#991b1b");
}

export function coldEndpointFeatureCollection(coords: LonLat[]): GeoJSON.FeatureCollection {
  return endpointFeatureCollection(coords, "#60a5fa", "#581c87");
}

function endpointFeatureCollection(
  coords: LonLat[],
  startColor: string,
  endColor: string,
): GeoJSON.FeatureCollection {
  const start = coords[0];
  const end = coords[coords.length - 1];

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "start", color: startColor },
        geometry: { type: "Point", coordinates: start },
      },
      {
        type: "Feature",
        properties: { kind: "end", color: endColor },
        geometry: { type: "Point", coordinates: end },
      },
    ],
  };
}

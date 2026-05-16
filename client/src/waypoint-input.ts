// @ts-ignore — open-location-code has no bundled type declarations
import { OpenLocationCode } from "open-location-code";

const olc = new OpenLocationCode();

export interface ParsedCoords {
  lat: number;
  lon: number;
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function coordsFromGoogleMapsUrl(url: string): ParsedCoords | null {
  const atMatch = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) {
    const lat = Number.parseFloat(atMatch[1]);
    const lon = Number.parseFloat(atMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const qMatch = url.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) {
    const lat = Number.parseFloat(qMatch[1]);
    const lon = Number.parseFloat(qMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  const llMatch = url.match(/[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (llMatch) {
    const lat = Number.parseFloat(llMatch[1]);
    const lon = Number.parseFloat(llMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  return null;
}

export function looksLikePlusCode(input: string): boolean {
  return /^[23456789CFGHJMPQRVWX+]+(\s+\S.*)?$/i.test(input.trim()) && input.includes("+");
}

export function decodePlusCode(
  code: string,
  refLat?: number,
  refLon?: number,
): ParsedCoords | null {
  try {
    const codeOnly = code.trim().split(/\s+/)[0].toUpperCase();

    if (olc.isFull(codeOnly)) {
      const area = olc.decode(codeOnly);
      return { lat: area.latitudeCenter, lon: area.longitudeCenter };
    }

    if (olc.isShort(codeOnly)) {
      if (refLat === undefined || refLon === undefined) return null;
      const recovered = olc.recoverNearest(codeOnly, refLat, refLon);
      const area = olc.decode(recovered);
      return { lat: area.latitudeCenter, lon: area.longitudeCenter };
    }
  } catch {
    return null;
  }

  return null;
}

export function parseWaypointInput(
  input: string,
  refLat?: number,
  refLon?: number,
): ParsedCoords | null {
  const value = input.trim();

  const latLonMatch = value.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (latLonMatch) {
    const lat = Number.parseFloat(latLonMatch[1]);
    const lon = Number.parseFloat(latLonMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  if (value.includes("google.com/maps") || value.includes("maps.google.com")) {
    return coordsFromGoogleMapsUrl(value);
  }

  if (looksLikePlusCode(value)) {
    return decodePlusCode(value, refLat, refLon);
  }

  return null;
}

export function isGoogleShortLink(url: string): boolean {
  return (
    url.startsWith("https://maps.app.goo.gl/") ||
    url.startsWith("http://maps.app.goo.gl/") ||
    url.startsWith("https://goo.gl/maps/") ||
    url.startsWith("http://goo.gl/maps/")
  );
}

export async function resolveGoogleShortLink(url: string): Promise<ParsedCoords | null> {
  const resp = await fetch(`/resolve-url?url=${encodeURIComponent(url)}`);
  if (!resp.ok) return null;
  const data = await resp.json() as { url?: string };
  return data.url ? coordsFromGoogleMapsUrl(data.url) : null;
}

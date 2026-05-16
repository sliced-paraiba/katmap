export type LonLat = [lon: number, lat: number];
export type LatLon = [lat: number, lon: number];

export interface LatLonLocation {
  lat: number;
  lon: number;
}

export function haversineMeters(from: LonLat, to: LonLat): number {
  const r = 6_371_000;
  const [lon1, lat1] = from.map((v) => v * Math.PI / 180) as LonLat;
  const [lon2, lat2] = to.map((v) => v * Math.PI / 180) as LonLat;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function distanceMeters(a: LatLonLocation, b: LatLonLocation): number {
  return haversineMeters([a.lon, a.lat], [b.lon, b.lat]);
}

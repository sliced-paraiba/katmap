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

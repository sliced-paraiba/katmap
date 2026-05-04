/**
 * Unit system for KatMap measurements.
 *
 * The main app supports switching between metric and imperial per measurement
 * type. The overlay always uses US imperial.
 */

export type UnitSystem = "metric" | "imperial";

export interface UserUnits {
  distance: UnitSystem;   // route distances, maneuver distances
  speed: UnitSystem;      // speed in live ETA, overlay telemetry
  altitude: UnitSystem;   // altitude in overlay telemetry
}

export const DEFAULT_UNITS: UserUnits = {
  distance: "metric",
  speed: "metric",
  altitude: "metric",
};

export const IMPERIAL_UNITS: UserUnits = Object.freeze({
  distance: "imperial",
  speed: "imperial",
  altitude: "imperial",
});

// ── Conversion helpers ────────────────────────────────────────────────

/** km → mi */
export function kmToMi(km: number): number {
  return km * 0.621371;
}

/** m/s → mph */
export function msToMph(ms: number): number {
  return ms * 2.23694;
}

/** m/s → km/h */
export function msToKmh(ms: number): number {
  return ms * 3.6;
}

/** meters → feet */
export function mToFt(m: number): number {
  return m * 3.28084;
}

/** km/h → mph */
export function kmhToMph(kmh: number): number {
  return kmh * 0.621371;
}

// ── Formatting ────────────────────────────────────────────────────────

/** Format a distance given in km using the specified unit system. */
export function formatDistance(km: number, units: UnitSystem): string {
  if (km < 0.01) return "";
  if (units === "imperial") {
    const mi = kmToMi(km);
    if (mi < 0.1) return `${Math.round(mi * 5280)} ft`;
    return `${mi.toFixed(1)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** Format a speed given in km/h using the specified unit system. */
export function formatSpeed(kmh: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${kmhToMph(kmh).toFixed(1)} mph`;
  }
  return `${kmh.toFixed(1)} km/h`;
}

/** Format speed from m/s to the specified unit system. */
export function formatSpeedMs(ms: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${msToMph(ms).toFixed(1)} mph`;
  }
  return `${msToKmh(ms).toFixed(1)} km/h`;
}

/** Format altitude given in meters using the specified unit system. */
export function formatAltitude(meters: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${Math.round(mToFt(meters))} ft`;
  }
  return `${Math.round(meters)} m`;
}

/** Format a route summary (total distance + time). */
export function formatRouteSummary(
  distanceKm: number,
  durationMin: number,
  units: UnitSystem,
): string {
  if (units === "imperial") {
    return `${kmToMi(distanceKm).toFixed(1)} mi · ${Math.round(durationMin)} min`;
  }
  return `${distanceKm.toFixed(1)} km · ${Math.round(durationMin)} min`;
}

/** Format remaining distance label (e.g. "5.2 km left" or "3.2 mi left"). */
export function formatDistanceLeft(km: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${kmToMi(km).toFixed(1)} mi left`;
  }
  return `${km.toFixed(1)} km left`;
}

/** Format a leg divider (e.g. "Leg 1 · 2.3 km"). */
export function formatLegDivider(legNum: number, km: number, units: UnitSystem): string {
  return `Leg ${legNum} · ${formatDistance(km, units)}`;
}

// ── Persistence ───────────────────────────────────────────────────────

const UNITS_STORAGE_KEY = "katmap-units";

export function loadStoredUnits(): UserUnits {
  try {
    const raw = localStorage.getItem(UNITS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserUnits>;
      return {
        distance: parsed.distance === "imperial" ? "imperial" : "metric",
        speed: parsed.speed === "imperial" ? "imperial" : "metric",
        altitude: parsed.altitude === "imperial" ? "imperial" : "metric",
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_UNITS };
}

export function saveStoredUnits(units: UserUnits): void {
  try {
    localStorage.setItem(UNITS_STORAGE_KEY, JSON.stringify(units));
  } catch { /* ignore */ }
}

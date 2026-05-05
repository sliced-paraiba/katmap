/**
 * Standalone weather overlay for OBS.
 *
 * Connects to the KatMap WebSocket to track the streamer's location,
 * then fetches current weather from Open-Meteo (free, no API key).
 * Reverse geocodes via Nominatim for city name (also free, no key).
 *
 * Usage:  /overlays/weather.html
 */

import { ServerMessage } from "./types";
import { wmoEmoji, wmoDescription } from "./weather";

// ── DOM ────────────────────────────────────────────────────────────────

const overlayEl = document.getElementById("weather-overlay")!;
const iconEl = document.getElementById("weather-icon")!;
const tempEl = document.getElementById("weather-temp")!;
const feelsEl = document.getElementById("weather-feels")!;
const locationEl = document.getElementById("weather-location")!;
const windEl = document.getElementById("weather-wind")!;
const timeEl = document.getElementById("weather-time")!;

// ── State ──────────────────────────────────────────────────────────────

/** Default location when no one is live (Seattle downtown). */
const FALLBACK_LAT = 47.6062;
const FALLBACK_LON = -122.3321;

let lastLat: number | null = null;
let lastLon: number | null = null;
let fetching = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let utcOffsetSeconds: number | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

// ── WebSocket ──────────────────────────────────────────────────────────

let ws: WebSocket;
let reconnectDelay = 1000;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?client=weather-overlay`);

  ws.onopen = () => {
    console.log("[weather] connected");
    reconnectDelay = 1000;
    // Fetch fallback weather immediately in case no one is live
    if (lastLat === null) {
      fetchWeather(FALLBACK_LAT, FALLBACK_LON);
    }
  };

  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch (err) {
      console.error("[weather] parse error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[weather] disconnected, reconnecting…");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };

  ws.onerror = () => ws.close();
}

function handleMessage(msg: ServerMessage) {
  if (msg.type !== "location") return;

  const lat = msg.lat;
  const lon = msg.lon;

  // Only re-fetch if moved > ~2 km
  if (lastLat !== null && lastLon !== null) {
    const dLat = lat - lastLat;
    const dLon = lon - lastLon;
    if (dLat * dLat + dLon * dLon < 0.0005) return;
  }

  lastLat = lat;
  lastLon = lon;
  fetchWeather(lat, lon);
}

// ── Unit conversions ──────────────────────────────────────────────────

function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

function kmhToMph(kmh: number): number {
  return kmh * 0.621371;
}

// ── Reverse geocode (Nominatim, free, 1 req/s) ────────────────────────

const countryCodes: Record<string, string> = {
  US: "US", GB: "UK", CA: "CA", DE: "DE", FR: "FR", JP: "JP", AU: "AU",
};

let geoTimer: ReturnType<typeof setTimeout> | null = null;

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&format=json&zoom=10`;
    const resp = await fetch(url, { headers: { "User-Agent": "KatMap-WeatherOverlay/1.0" } });
    if (!resp.ok) return "";
    const data = await resp.json() as {
      address?: { city?: string; town?: string; village?: string; hamlet?: string; country_code?: string };
    };
    const addr = data.address;
    if (!addr) return "";
    const city = addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? "";
    const cc = addr.country_code?.toUpperCase() ?? "";
    if (!city && !cc) return "";
    return cc ? `${city}, ${countryCodes[cc] ?? cc}` : city;
  } catch {
    return "";
  }
}

// ── Weather fetch ──────────────────────────────────────────────────────

interface CurrentWeather {
  temperature: number;
  apparentTemperature: number;
  weatherCode: number;
  isDay: boolean;
  windSpeed: number; // km/h
}

async function fetchWeather(lat: number, lon: number) {
  if (fetching) return;
  fetching = true;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json() as {
      utc_offset_seconds?: number;
      current?: {
        temperature_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        is_day?: number;
        wind_speed_10m?: number;
      };
    };

    const c = data.current;
    if (!c || c.temperature_2m == null || c.weather_code == null) return;

    // Store UTC offset for local clock
    if (data.utc_offset_seconds != null) {
      utcOffsetSeconds = data.utc_offset_seconds;
      startClock();
    }

    const weather: CurrentWeather = {
      temperature: c.temperature_2m,
      apparentTemperature: c.apparent_temperature ?? c.temperature_2m,
      weatherCode: c.weather_code,
      isDay: c.is_day !== 0,
      windSpeed: c.wind_speed_10m ?? 0,
    };

    // Kick off reverse geocode (rate-limited to ~1/s via debounce)
    if (geoTimer) clearTimeout(geoTimer);
    geoTimer = setTimeout(async () => {
      const loc = await reverseGeocode(lat, lon);
      if (loc) locationEl.textContent = loc;
    }, 200);

    render(weather);
  } catch {
    // Silent — weather is non-essential
  } finally {
    fetching = false;
  }
}

function render(data: CurrentWeather) {
  const emoji = wmoEmoji(data.weatherCode, data.isDay);
  const desc = wmoDescription(data.weatherCode);
  const temp = `${Math.round(cToF(data.temperature))}°`;
  const feelsLike = Math.round(cToF(data.apparentTemperature));
  const wind = `${Math.round(kmhToMph(data.windSpeed))} mph`;

  iconEl.textContent = emoji;
  tempEl.textContent = temp;
  feelsEl.textContent = feelsLike !== Math.round(data.temperature) ? `feels ${feelsLike}°` : "";
  windEl.textContent = wind;

  overlayEl.title = `${desc}, ${temp} (feels ${feelsLike}°), ${wind}`;
  overlayEl.style.display = "flex";

  // Schedule refresh in 10 minutes
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (lastLat !== null && lastLon !== null) {
      fetchWeather(lastLat, lastLon);
    }
  }, 10 * 60 * 1000);
}

// ── Local clock ───────────────────────────────────────────────────────

function startClock() {
  if (clockTimer) return; // already running
  const tick = () => {
    if (utcOffsetSeconds == null) return;
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
    const localMs = utcMs + utcOffsetSeconds * 1000;
    const local = new Date(localMs);
    const h = local.getHours();
    const m = String(local.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    timeEl.textContent = `${h12}:${m} ${ampm}`;
  };
  tick();
  clockTimer = setInterval(tick, 10_000); // update every 10s is plenty
}

// ── Start ──────────────────────────────────────────────────────────────

connect();

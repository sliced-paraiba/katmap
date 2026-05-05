/**
 * Standalone weather overlay for OBS.
 *
 * Connects to the KatMap WebSocket to track the streamer's location,
 * then fetches current weather from Open-Meteo (free, no API key).
 *
 * Usage:  /weather.html
 */

import { ServerMessage } from "./types";
import { WeatherData } from "./weather";
import { wmoEmoji, wmoDescription } from "./weather";

// ── DOM ────────────────────────────────────────────────────────────────

const overlayEl = document.getElementById("weather-overlay")!;
const iconEl = document.getElementById("weather-icon")!;
const tempEl = document.getElementById("weather-temp")!;

// ── State ──────────────────────────────────────────────────────────────

let lastLat: number | null = null;
let lastLon: number | null = null;
let fetching = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ── WebSocket ──────────────────────────────────────────────────────────

let ws: WebSocket;
let reconnectDelay = 1000;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?client=weather-overlay`);

  ws.onopen = () => {
    console.log("[weather] connected");
    reconnectDelay = 1000;
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

// ── Weather fetch ──────────────────────────────────────────────────────

async function fetchWeather(lat: number, lon: number) {
  if (fetching) return;
  fetching = true;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,weather_code,is_day`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json() as {
      current?: {
        temperature_2m?: number;
        weather_code?: number;
        is_day?: number;
      };
    };

    const current = data.current;
    if (!current || current.temperature_2m == null || current.weather_code == null) return;

    const weather: WeatherData = {
      temperature: current.temperature_2m,
      weatherCode: current.weather_code,
      isDay: current.is_day !== 0,
    };

    render(weather);
  } catch {
    // Silent — weather is non-essential
  } finally {
    fetching = false;
  }
}

function render(data: WeatherData) {
  const emoji = wmoEmoji(data.weatherCode, data.isDay);
  const desc = wmoDescription(data.weatherCode);
  const temp = `${Math.round(data.temperature)}°C`;

  iconEl.textContent = emoji;
  tempEl.textContent = temp;
  overlayEl.title = `${desc}, ${temp}`;
  overlayEl.style.display = "flex";

  // Schedule refresh in 10 minutes
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (lastLat !== null && lastLon !== null) {
      fetchWeather(lastLat, lastLon);
    }
  }, 10 * 60 * 1000);
}

// ── Start ──────────────────────────────────────────────────────────────

connect();

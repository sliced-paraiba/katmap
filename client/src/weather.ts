/**
 * Minimal weather widget using Open-Meteo (free, no API key).
 *
 * Fetches current conditions for a lat/lon and renders a small
 * temperature + icon badge. Designed to be embedded in the overlay.
 *
 * API: https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code&...
 */

export interface WeatherData {
  temperature: number; // °C
  weatherCode: number; // WMO code
  isDay: boolean;
}

/** WMO weather code → single emoji. Night-aware for clear/cloudy. */
export function wmoEmoji(code: number, isDay: boolean): string {
  switch (code) {
    case 0:  return isDay ? "\u2600\uFE0F" : "\uD83C\uDF19";  // ☀️ / 🌙
    case 1:  return isDay ? "\uD83C\uDF24" : "\uD83C\uDF19";  // 🌤 / 🌙
    case 2:  return "\u26C5";        // ⛅
    case 3:  return "\u2601\uFE0F";  // ☁️
    case 45:
    case 48: return "\uD83C\uDF2B";  // Fog 🌫
    case 51:
    case 53:
    case 55:
    case 56:
    case 57: return "\uD83C\uDF26";  // Drizzle 🌦
    case 61:
    case 63:
    case 65:
    case 66:
    case 67: return "\uD83C\uDF27";  // Rain 🌧
    case 71:
    case 73:
    case 75:
    case 77: return "\uD83C\uDF28";  // Snow 🌨
    case 80:
    case 81:
    case 82: return "\uD83C\uDF27";  // Rain showers 🌧
    case 85:
    case 86: return "\uD83C\uDF28";  // Snow showers 🌨
    case 95:
    case 96:
    case 99: return "\u26C8\uFE0F";  // Thunderstorm ⛈
    default: return "\u2753";         // Unknown ❓
  }
}

/** WMO weather code → short description. */
export function wmoDescription(code: number): string {
  switch (code) {
    case 0:  return "Clear";
    case 1:  return "Mostly clear";
    case 2:  return "Partly cloudy";
    case 3:  return "Overcast";
    case 45: return "Fog";
    case 48: return "Freezing fog";
    case 51: return "Light drizzle";
    case 53: return "Drizzle";
    case 55: return "Heavy drizzle";
    case 56: return "Light freezing drizzle";
    case 57: return "Freezing drizzle";
    case 61: return "Light rain";
    case 63: return "Rain";
    case 65: return "Heavy rain";
    case 66: return "Light freezing rain";
    case 67: return "Freezing rain";
    case 71: return "Light snow";
    case 73: return "Snow";
    case 75: return "Heavy snow";
    case 77: return "Snow grains";
    case 80: return "Rain showers";
    case 81: return "Moderate showers";
    case 82: return "Heavy showers";
    case 85: return "Snow showers";
    case 86: return "Heavy snow showers";
    case 95: return "Thunderstorm";
    case 96: return "Thunderstorm w/ hail";
    case 99: return "Severe thunderstorm";
    default: return "Unknown";
  }
}

export class WeatherWidget {
  private el: HTMLElement;
  private tempEl: HTMLElement;
  private iconEl: HTMLElement;
  private lastLat: number | null = null;
  private lastLon: number | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private fetching = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "weather-widget";
    this.el.title = "";
    this.iconEl = document.createElement("span");
    this.iconEl.className = "weather-icon";
    this.tempEl = document.createElement("span");
    this.tempEl.className = "weather-temp";
    this.el.appendChild(this.iconEl);
    this.el.appendChild(this.tempEl);

    // Initial state
    this.iconEl.textContent = "";
    this.tempEl.textContent = "";
    this.el.style.display = "none";

    container.appendChild(this.el);
  }

  /** Update the widget for a new position. Fetches weather if moved enough. */
  update(lat: number, lon: number) {
    // Only re-fetch if moved > ~2 km
    if (this.lastLat !== null && this.lastLon !== null) {
      const dLat = lat - this.lastLat;
      const dLon = lon - this.lastLon;
      const dist2 = dLat * dLat + dLon * dLon;
      if (dist2 < 0.0005) return; // ~0.02° ≈ 2 km
    }

    this.lastLat = lat;
    this.lastLon = lon;
    this.fetchWeather(lat, lon);
  }

  private async fetchWeather(lat: number, lon: number) {
    if (this.fetching) return;
    this.fetching = true;

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

      this.render(weather);
    } catch {
      // Silent — weather is non-essential
    } finally {
      this.fetching = false;
    }
  }

  private render(data: WeatherData) {
    const emoji = wmoEmoji(data.weatherCode, data.isDay);
    const desc = wmoDescription(data.weatherCode);
    const temp = `${Math.round(data.temperature)}°C`;

    this.iconEl.textContent = emoji;
    this.tempEl.textContent = temp;
    this.el.title = `${desc}, ${temp}`;
    this.el.style.display = "";

    // Schedule refresh in 10 minutes
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => {
      if (this.lastLat !== null && this.lastLon !== null) {
        this.fetchWeather(this.lastLat, this.lastLon);
      }
    }, 10 * 60 * 1000);
  }

  destroy() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.el.remove();
  }
}

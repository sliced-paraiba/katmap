import { Connection } from "./net";
import { AppState } from "./state";
import { MapView, reverseGeocode } from "./map";
import { Theme } from "./themes";
import { Sidebar } from "./sidebar";
import { strings } from "./strings";

const state = new AppState();

type VersionInfo = {
  commit: string;
  build_time: string;
};

const conn = new Connection(
  (msg) => state.applyServerMessage(msg),
  (connected) => {
    state.setConnected(connected);
    if (!connected) {
      showToast(strings.toast.disconnected, "error");
    } else {
      showToast(strings.toast.connected, "success");
    }
  }
);

const send = (msg: Parameters<Connection["send"]>[0]) => conn.send(msg);

// Theme dropdown (placed over the map)
const themeSelect = document.getElementById("theme-select") as HTMLSelectElement;

const VALID_THEMES: Theme[] = ["dark", "light", "bright", "fiord", "toner", "basic", "neon", "midnight", "raster"];
const STORAGE_KEY = "katmap-theme";

// Populate theme options from strings
for (const key of VALID_THEMES) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = strings.themes[key as keyof typeof strings.themes];
  themeSelect.appendChild(opt);
}

function loadStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored && VALID_THEMES.includes(stored) && stored !== "raster") return stored;
  } catch { /* ignore */ }
  return "dark";
}

const initialTheme = loadStoredTheme();
themeSelect.value = initialTheme;

function onThemeChange(theme: Theme) {
  themeSelect.value = theme;
  // Persist to localStorage (skip "raster" — it's a fallback, not a user choice)
  if (theme !== "raster") {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  }
}

// --- Follow/track streamer toggle ---
const followToggle = document.getElementById("follow-toggle") as HTMLButtonElement;

const mapView = new MapView(
  "map-container",
  state,
  send,
  onThemeChange,
  initialTheme,
  (following) => {
    followToggle.classList.toggle("active", following);
  }
);
const sidebar = new Sidebar(
  document.getElementById("sidebar")!,
  state,
  send,
  () => mapView.enterPinMode(async (lat, lon) => {
    const label = (await reverseGeocode(lat, lon)) ?? `Stop ${state.waypoints.length + 1}`;
    send({ type: "add_waypoint", lat, lon, label });
  }),
  () => mapView.exitPinMode()
);

themeSelect.addEventListener("change", () => {
  mapView.setTheme(themeSelect.value as Theme);
});

followToggle.addEventListener("click", () => {
  mapView.setFollow(!mapView.getFollow());
});

// Help button (top-left map control)
const helpToggle = document.getElementById("help-toggle")!;
helpToggle.addEventListener("click", () => {
  sidebar.toggleHelpCard();
});

// --- Mobile sidebar toggle ---
const sidebarEl = document.getElementById("sidebar")!;
const sidebarOverlay = document.getElementById("sidebar-overlay")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;

function openSidebar() {
  sidebarEl.classList.add("sidebar-open");
  sidebarOverlay.classList.add("visible");
}

function closeSidebar() {
  sidebarEl.classList.remove("sidebar-open");
  sidebarOverlay.classList.remove("visible");
}

sidebarToggle.addEventListener("click", () => {
  if (sidebarEl.classList.contains("sidebar-open")) {
    closeSidebar();
  } else {
    openSidebar();
  }
});

sidebarOverlay.addEventListener("click", closeSidebar);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    mapView.exitPinMode();
    sidebar.stopPinDrop();
    closeSidebar();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    send({ type: "undo" });
  }
});

// Auto-recalculate route when waypoints change
let lastWaypointJson = "";

state.subscribe(() => {
  const wpJson = JSON.stringify(state.waypoints.map((w) => [w.id, w.lat, w.lon, w.active !== false]));
  if (wpJson === lastWaypointJson) return;
  lastWaypointJson = wpJson;

  // Clear stale routes immediately
  state.clearRoute();

  if (state.waypoints.filter((w) => w.active !== false).length >= 2) {
    send({ type: "request_route" });
  }
});

// Throttled live route requests: recalculate from streamer's position every 30s
const LIVE_ROUTE_INTERVAL = 30_000;
let lastLiveRouteAt = 0;

state.subscribe(() => {
  if (!state.location || !state.live || state.waypoints.some((w) => w.active !== false) === false) return;

  const now = Date.now();
  if (now - lastLiveRouteAt < LIVE_ROUTE_INTERVAL) return;
  lastLiveRouteAt = now;

  send({ type: "request_live_route" });
});

// Error toast from server messages
state.subscribe(() => {
  if (state.lastError && state.errorTimestamp > Date.now() - 500) {
    showToast(state.lastError, "error");
  }
});

// --- Dynamic favicon from Twitch avatar ---
const faviconEl = document.getElementById("favicon") as HTMLLinkElement;

function drawFallbackFavicon() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fillStyle = "#0f9b8e";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("K", 16, 16);
  faviconEl.href = canvas.toDataURL("image/png");
}

function updateFavicon() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    // Circular clip
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, 2, 2, 28, 28);
    // Accent ring
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.strokeStyle = "#0f9b8e";
    ctx.lineWidth = 2;
    ctx.stroke();
    faviconEl.href = canvas.toDataURL("image/png");
  };
  img.onerror = () => drawFallbackFavicon();
  img.src = `/api/avatar`;
}

// --- Connected users counter (now in sidebar header) ---
const userCountEl = document.querySelector("#user-count")!;

state.subscribe(() => {
  userCountEl.textContent = String(state.connectedCount);
});

// Draw initial fallback favicon right away
drawFallbackFavicon();

// --- Fetch config (display name + social links) ---
(async () => {
  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) throw new Error(`/api/config returned ${resp.status}`);
    const cfg = await resp.json() as { display_name: string; social?: { discord?: string | null; kick?: string | null; twitch?: string | null } };

    if (cfg.display_name) {
      updateFavicon();
    }

    state.socialLinks = {
      discord: cfg.social?.discord ?? null,
      kick: cfg.social?.kick ?? null,
      twitch: cfg.social?.twitch ?? null,
    };
    sidebar.renderSocialLinks();
  } catch (err) {
    console.error("Failed to fetch config:", err);
  }
})();

// --- Toast system ---
const toastContainer = document.createElement("div");
toastContainer.id = "toast-container";
document.body.appendChild(toastContainer);

let hideTimeout: ReturnType<typeof setTimeout> | null = null;
let updateToastVisible = false;

function showToast(message: string, type: "error" | "success" | "info" = "info") {
  if (updateToastVisible) return;
  if (hideTimeout) clearTimeout(hideTimeout);

  toastContainer.textContent = message;
  toastContainer.className = `toast toast-${type} toast-visible`;

  const duration = type === "error" ? 5000 : 2000;
  hideTimeout = setTimeout(() => {
    toastContainer.classList.remove("toast-visible");
  }, duration);
}

function showUpdateToast() {
  updateToastVisible = true;
  if (hideTimeout) clearTimeout(hideTimeout);

  toastContainer.className = "toast toast-info toast-update toast-visible";
  toastContainer.innerHTML = `
    <span>${strings.toast.updateAvailable}</span>
    <button type="button" class="toast-reload-btn">${strings.toast.reload}</button>
  `;
  toastContainer
    .querySelector<HTMLButtonElement>(".toast-reload-btn")
    ?.addEventListener("click", () => window.location.reload());
}

function sameVersion(a: VersionInfo, b: VersionInfo): boolean {
  return a.commit === b.commit && a.build_time === b.build_time;
}

async function fetchVersion(): Promise<VersionInfo | null> {
  try {
    const resp = await fetch(`/api/version?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json() as VersionInfo;
  } catch {
    return null;
  }
}

async function startUpdatePolling() {
  const loadedVersion = await fetchVersion();
  if (!loadedVersion) return;

  let updateShown = false;
  const checkForUpdate = async () => {
    if (updateShown) return;
    const latestVersion = await fetchVersion();
    if (!latestVersion || sameVersion(loadedVersion, latestVersion)) return;
    updateShown = true;
    showUpdateToast();
  };

  window.setInterval(checkForUpdate, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  });
}

void startUpdatePolling();

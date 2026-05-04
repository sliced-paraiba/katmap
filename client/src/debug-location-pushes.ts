import "./debug-location-pushes.css";
import { escapeHtml } from "./html";
import type { DebugPush, DebugSnapshot } from "./api-types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenEl = $("token") as HTMLInputElement;
const autoEl = $("auto") as HTMLInputElement;
let timer: number | null = null;

tokenEl.value = localStorage.getItem("katmap-debug-token") || "";
tokenEl.addEventListener("input", () => localStorage.setItem("katmap-debug-token", tokenEl.value));
$("refresh").onclick = () => void refresh();
autoEl.onchange = () => setupAutoRefresh();
setupAutoRefresh();
void refresh();

function setupAutoRefresh() {
  if (timer != null) window.clearInterval(timer);
  timer = autoEl.checked ? window.setInterval(() => void refresh(), 3000) : null;
}

async function refresh() {
  if (!tokenEl.value) {
    setStatus("Enter token");
    return;
  }
  try {
    const res = await fetch("/api/debug/location-pushes", {
      headers: { Authorization: `Bearer ${tokenEl.value}` },
    });
    if (!res.ok) throw new Error(await res.text() || res.statusText);
    render(await res.json() as DebugSnapshot);
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function render(snapshot: DebugSnapshot) {
  $("server-summary").innerHTML = dl({
    live: snapshot.live ? "yes" : "no",
    commit: shortCommit(snapshot.version.commit),
    build_time: snapshot.version.build_time,
    started_at: fmt(snapshot.started_at),
    breadcrumb_count: String(snapshot.breadcrumb_count),
    last_location_ts: fmt(snapshot.last_location_ts),
    age_ms: age(snapshot.age_ms),
    last_push_age_ms: age(snapshot.last_push_age_ms),
  });

  const latest = snapshot.latest_push;
  $("latest-summary").innerHTML = latest ? dl(summaryFor(latest)) : dl({ latest: "none received since last server start" });
  $("raw").textContent = JSON.stringify(latest?.payload ?? {}, null, 2);

  $("pushes").innerHTML = snapshot.recent_pushes.map(rowFor).join("");
}

function summaryFor(push: DebugPush): Record<string, string> {
  const p = push.payload;
  if (p.type === "stop") {
    return { received: fmt(push.received_at_ms), type: "stop" };
  }
  return {
    received: fmt(push.received_at_ms),
    type: p.type,
    timestamp_ms: fmt(p.timestamp_ms),
    lat: String(p.lat),
    lon: String(p.lon),
    accuracy: value(p.accuracy, "m"),
    heading: value(p.heading, "°"),
    speed: p.speed == null ? "missing" : `${p.speed} m/s (${(p.speed * 3.6).toFixed(1)} km/h)`,
    altitude: value(p.altitude, "m"),
    altitude_accuracy: value(p.altitude_accuracy, "m"),
  };
}

function rowFor(push: DebugPush): string {
  const p = push.payload;
  if (p.type === "stop") {
    return `<tr><td>${fmt(push.received_at_ms)}</td><td>stop</td><td colspan="7" class="missing">—</td></tr>`;
  }
  return `<tr>
    <td>${fmt(push.received_at_ms)}</td>
    <td>${p.type}</td>
    <td>${fmt(p.timestamp_ms)}</td>
    <td>${p.lat}</td>
    <td>${p.lon}</td>
    ${cell(p.accuracy, "m")}
    ${cell(p.heading, "°")}
    ${cell(p.speed, "m/s")}
    ${cell(p.altitude, "m")}
  </tr>`;
}

function dl(values: Record<string, string>): string {
  return Object.entries(values).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function cell(v: unknown, suffix = ""): string {
  const missing = v == null || (typeof v === "number" && !Number.isFinite(v));
  return `<td class="${missing ? "missing" : "present"}">${escapeHtml(missing ? "missing" : `${v}${suffix}`)}</td>`;
}

function value(v: unknown, suffix = ""): string {
  return v == null || (typeof v === "number" && !Number.isFinite(v)) ? "missing" : `${v}${suffix}`;
}

function fmt(ms?: number | null): string {
  return ms ? new Date(ms).toISOString() : "missing";
}

function age(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "missing";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function shortCommit(commit: string): string {
  return commit === "unknown" ? commit : commit.slice(0, 12);
}

function setStatus(message: string) {
  $("status").textContent = message;
}

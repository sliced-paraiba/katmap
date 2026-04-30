import Sortable from "sortablejs";
// @ts-ignore — open-location-code has no bundled type declarations
import { OpenLocationCode } from "open-location-code";
import { AppState } from "./state";
import { ClientMessage, Maneuver } from "./types";
import { reverseGeocode } from "./map";
import { strings } from "./strings";

const olc = new OpenLocationCode();

// ---------------------------------------------------------------------------
// Waypoint input parsing
// ---------------------------------------------------------------------------

interface ParsedCoords {
  lat: number;
  lon: number;
}

/**
 * Try to extract coordinates from a full Google Maps URL.
 * Handles:
 *   https://www.google.com/maps/place/.../@34.0522,-118.2437,15z
 *   https://www.google.com/maps/search/.../@34.0522,-118.2437,15z
 *   https://maps.google.com/?q=34.0522,-118.2437
 *   https://www.google.com/maps?q=34.0522,-118.2437
 */
function coordsFromGoogleMapsUrl(url: string): ParsedCoords | null {
  // @lat,lon,zoom pattern in path
  const atMatch = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lon = parseFloat(atMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  // ?q=lat,lon or &q=lat,lon
  const qMatch = url.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lon = parseFloat(qMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  // ?ll=lat,lon
  const llMatch = url.match(/[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (llMatch) {
    const lat = parseFloat(llMatch[1]);
    const lon = parseFloat(llMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  return null;
}

/** True if the coordinates are in valid geographic ranges. */
function isValidLatLon(lat: number, lon: number): boolean {
  return (
    !isNaN(lat) && !isNaN(lon) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

/**
 * Detect if a string looks like a Plus Code (full or short).
 * Plus codes use the character set 23456789CFGHJMPQRVWX and contain a '+'.
 */
function looksLikePlusCode(s: string): boolean {
  // Must contain a '+' and consist of valid plus-code chars (and possibly spaces for short codes)
  return /^[23456789CFGHJMPQRVWX+]+(\s+\S.*)?$/i.test(s.trim()) && s.includes("+");
}

/**
 * Decode a Plus Code to coordinates.
 * @param code  The Plus Code string (may be short, e.g. "CWC8+R9 Los Angeles")
 * @param refLat  Reference latitude for short code recovery (e.g. streamer's location)
 * @param refLon  Reference longitude for short code recovery
 */
function decodePlusCode(
  code: string,
  refLat?: number,
  refLon?: number
): ParsedCoords | null {
  try {
    const trimmed = code.trim();

    // Split "shortcode city" — plus code is the first token
    const parts = trimmed.split(/\s+/);
    const codeOnly = parts[0].toUpperCase();

    if (olc.isFull(codeOnly)) {
      const area = olc.decode(codeOnly);
      return { lat: area.latitudeCenter, lon: area.longitudeCenter };
    }

    if (olc.isShort(codeOnly)) {
      if (refLat !== undefined && refLon !== undefined) {
        const recovered = olc.recoverNearest(codeOnly, refLat, refLon);
        const area = olc.decode(recovered);
        return { lat: area.latitudeCenter, lon: area.longitudeCenter };
      }
      // No reference: can't decode a short code without context
      return null;
    }
  } catch (_) {
    // invalid code
  }
  return null;
}

/**
 * Parse a raw text input into lat/lon coordinates.
 * Supports:
 *   - "lat, lon" or "lat lon" plain coordinate pairs
 *   - Full Google Maps URLs (coordinate extraction from URL)
 *   - Plus codes (full and short — short codes use streamer location as reference)
 *
 * Short Google Maps URLs (goo.gl/maps, maps.app.goo.gl) must be resolved
 * server-side first; this function does NOT handle them. See resolveAndParse().
 */
function parseInput(
  input: string,
  refLat?: number,
  refLon?: number
): ParsedCoords | null {
  const s = input.trim();

  // Plain "lat, lon" or "lat lon"
  const latLonMatch = s.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (latLonMatch) {
    const lat = parseFloat(latLonMatch[1]);
    const lon = parseFloat(latLonMatch[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  // Full Google Maps URL (no redirect needed)
  if (
    s.includes("google.com/maps") ||
    s.includes("maps.google.com")
  ) {
    return coordsFromGoogleMapsUrl(s);
  }

  // Plus code
  if (looksLikePlusCode(s)) {
    return decodePlusCode(s, refLat, refLon);
  }

  return null;
}

/** True if the URL looks like a Google Maps short link that needs server resolution. */
function isGoogleShortLink(url: string): boolean {
  return (
    url.startsWith("https://maps.app.goo.gl/") ||
    url.startsWith("http://maps.app.goo.gl/") ||
    url.startsWith("https://goo.gl/maps/") ||
    url.startsWith("http://goo.gl/maps/")
  );
}

/**
 * Resolve a Google Maps short link via the /resolve-url server endpoint,
 * then extract coordinates from the final URL.
 */
async function resolveShortLink(url: string): Promise<ParsedCoords | null> {
  const resp = await fetch(`/resolve-url?url=${encodeURIComponent(url)}`);
  if (!resp.ok) return null;
  const data = await resp.json() as { url?: string; error?: string };
  if (!data.url) return null;
  return coordsFromGoogleMapsUrl(data.url);
}

/**
 * Map Valhalla maneuver_type to a Unicode arrow/symbol.
 * See: https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
 */
function maneuverIcon(type: number): string {
  switch (type) {
    case 0:  return "\u2022";       // None — bullet
    case 1:  return "\u25B6";       // Start — right-pointing triangle
    case 2:  return "\u25B6";       // StartRight
    case 3:  return "\u25C0";       // StartLeft
    case 4:  return "\u2691";       // Destination — flag
    case 5:  return "\u2691";       // DestinationRight
    case 6:  return "\u2691";       // DestinationLeft
    case 7:  return "\u2B06";       // Becomes
    case 8:  return "\u2B06";       // Continue — up arrow
    case 9:  return "\u2197";       // SlightRight — NE arrow
    case 10: return "\u27A1";       // Right — right arrow
    case 11: return "\u2198";       // SharpRight — SE arrow (used as sharp right)
    case 12: return "\u21B6";       // UturnRight
    case 13: return "\u21B5";       // UturnLeft
    case 14: return "\u2199";       // SharpLeft — SW arrow
    case 15: return "\u2B05";       // Left — left arrow
    case 16: return "\u2196";       // SlightLeft — NW arrow
    case 17: return "\u2B06";       // RampStraight
    case 18: return "\u2197";       // RampRight
    case 19: return "\u2196";       // RampLeft
    case 20: return "\u2197";       // ExitRight
    case 21: return "\u2196";       // ExitLeft
    case 22: return "\u2B06";       // StayStraight
    case 23: return "\u27A1";       // StayRight
    case 24: return "\u2B05";       // StayLeft
    case 25: return "\u2B06";       // Merge
    case 26: return "\u21BB";       // RoundaboutEnter — clockwise arrow
    case 27: return "\u21BB";       // RoundaboutExit
    case 28: return "\u26F4";       // FerryEnter
    case 29: return "\u26F4";       // FerryExit
    case 30: return "\u2708";       // Transit
    case 31: return "\u2708";       // TransitTransfer
    case 32: return "\u2708";       // TransitRemainOn
    case 33: return "\u2708";       // TransitConnectionStart
    case 34: return "\u2708";       // TransitConnectionTransfer
    case 35: return "\u2708";       // TransitConnectionDestination
    case 36: return "\u2708";       // PostTransitConnectionDestination
    case 37: return "\u2B06";       // MergeRight
    case 38: return "\u2B06";       // MergeLeft
    case 39: return "\u25A0";       // ElevatorEnter — square
    case 40: return "\u25B2";       // StepsEnter — up triangle
    case 41: return "\u25B2";       // EscalatorEnter
    case 42: return "\u2302";       // BuildingEnter — house
    case 43: return "\u2302";       // BuildingExit
    default: return "\u2022";       // Fallback bullet
  }
}

function formatDistance(km: number): string {
  if (km < 0.01) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export class Sidebar {
  private container: HTMLElement;
  private state: AppState;
  private onSend: (msg: ClientMessage) => void;
  private listEl: HTMLElement;
  private routeInfoEl: HTMLElement;
  private statusDot: HTMLElement;
  private streamerStatusEl: HTMLElement;
  private addPositionBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private deleteAllBtn: HTMLButtonElement;
  private waypointInputEl: HTMLInputElement;
  private waypointInputBtn: HTMLButtonElement;
  private sortable: Sortable | null = null;
  private lastAddPositionTime = 0;
  private isAddingWaypoint = false;
  private historyPanelEl: HTMLElement;
  private historyListEl: HTMLElement;
  private historyVisible = false;
  private socialLinksEl: HTMLElement;
  private helpCard: HTMLElement;
  private isTouch: boolean;
  private enterPinMode: (() => void) | null = null;
  private exitPinMode: (() => void) | null = null;
  private isPinMode = false;

  constructor(
    container: HTMLElement,
    state: AppState,
    onSend: (msg: ClientMessage) => void,
    enterPinMode?: (() => void) | null,
    exitPinMode?: (() => void) | null,
  ) {
    this.container = container;
    this.state = state;
    this.onSend = onSend;
    this.enterPinMode = enterPinMode ?? null;
    this.exitPinMode = exitPinMode ?? null;
    this.isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    // Build DOM
    this.container.innerHTML = `
      <div class="sidebar-header">
        <h1>${strings.sidebar.headerTitle} <span class="connection-status disconnected" id="conn-status" title="${strings.sidebar.disconnected}"></span> <span id="user-count" class="user-count-inline"></span></h1>
        <div class="streamer-status" id="streamer-status"></div>
        <button class="add-position-btn" id="add-position-btn" style="display:none">
          ${strings.sidebar.addStreamerLocation}
        </button>
      </div>
      <div class="social-links" id="social-links"></div>
      <div class="waypoint-actions" id="waypoint-actions">
        <button class="action-btn undo-btn" id="undo-btn" title="${strings.sidebar.undoTitle}">${strings.sidebar.undo}</button>
        <button class="action-btn delete-all-btn" id="delete-all-btn" title="${strings.sidebar.deleteAllTitle}">${strings.sidebar.deleteAll}</button>
        <button class="action-btn history-btn" id="history-btn" title="${strings.sidebar.historyTitle}">${strings.sidebar.history}</button>
      </div>
      </div>
      <div class="history-panel" id="history-panel" style="display:none">
        <div class="history-header">
          <span>${strings.sidebar.pastStreams}</span>
          <button class="history-close" id="history-close-btn">&times;</button>
        </div>
        <div class="history-list" id="history-list"></div>
      </div>
      <div class="waypoint-input-row" id="waypoint-input-row">
        <input
          type="text"
          id="waypoint-input"
          class="waypoint-input"
          placeholder="${strings.sidebar.inputPlaceholder}"
          title="${strings.sidebar.inputTitle}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button class="waypoint-input-btn" id="waypoint-input-btn" title="${strings.sidebar.inputButtonTitle}">${strings.sidebar.inputButton}</button>
      </div>
      <div class="waypoint-list" id="waypoint-list"></div>
      <div class="route-info" id="route-info"></div>
    `;

    // Help card is a full-screen overlay on document.body, not inside the sidebar
    this.helpCard = document.createElement("div");
    this.helpCard.id = "help-card";
    this.helpCard.className = "help-overlay";
    this.helpCard.style.display = "none";
    this.helpCard.innerHTML = `
      <div class="help-card">
        <div class="help-card-close" id="help-card-close" title="${strings.sidebar.helpDismissTitle}">${strings.sidebar.helpDismiss}</div>
        <h2>${strings.help.heading}</h2>
        <p class="help-intro">${strings.help.intro}</p>
        <h3>${strings.help.addTitle}</h3>
        <p class="help-add-details">${this.isTouch ? strings.help.addDetailsMobile : strings.help.addDetailsDesktop}</p>
        <h3>${strings.help.reorderTitle}</h3>
        <p>${strings.help.reorderDetails}</p>
        <p class="help-note">${strings.help.autoRoute}</p>
        <h3>${strings.help.activeTitle}</h3>
        <p>${strings.help.activeDetails}</p>
        <h3>${strings.help.liveEtaTitle}</h3>
        <p>${strings.help.liveEtaDetails}</p>
        <h3>${strings.help.undoTitle}</h3>
        <p>${strings.help.undoDetails}</p>
        <h3>${strings.help.historyTitle}</h3>
        <p>${strings.help.historyDetails}</p>
        <p class="help-farewell">${strings.help.farewell}</p>
      </div>
    `;
    document.body.appendChild(this.helpCard);

    this.listEl = this.container.querySelector("#waypoint-list")!;
    this.routeInfoEl = this.container.querySelector("#route-info")!;
    this.statusDot = this.container.querySelector("#conn-status")!;
    this.streamerStatusEl = this.container.querySelector("#streamer-status")!;
    this.addPositionBtn = this.container.querySelector("#add-position-btn")!;
    this.undoBtn = this.container.querySelector("#undo-btn")!;
    this.deleteAllBtn = this.container.querySelector("#delete-all-btn")!;
    this.waypointInputEl = this.container.querySelector("#waypoint-input")!;
    this.waypointInputBtn = this.container.querySelector("#waypoint-input-btn")!;
    this.historyPanelEl = this.container.querySelector("#history-panel")!;
    this.historyListEl = this.container.querySelector("#history-list")!;
    this.socialLinksEl = this.container.querySelector("#social-links")!;
    this.helpCard = this.helpCard;  // already built and appended to body

    const historyBtn = this.container.querySelector("#history-btn")!;
    const historyCloseBtn = this.container.querySelector("#history-close-btn")!;

    this.addPositionBtn.addEventListener("click", () => this.onAddStreamerPosition());
    this.undoBtn.addEventListener("click", () => this.onSend({ type: "undo" }));
    this.deleteAllBtn.addEventListener("click", () => {
      if (this.state.waypoints.length === 0) return;
      this.onSend({ type: "delete_all" });
    });

    historyBtn.addEventListener("click", () => {
      if (!this.historyVisible) {
        this.historyPanelEl.style.display = "block";
        this.historyVisible = true;
        this.state.fetchHistory().then(() => this.renderHistoryList());
      } else {
        this.historyPanelEl.style.display = "none";
        this.historyVisible = false;
      }
    });

    historyCloseBtn.addEventListener("click", () => {
      this.historyPanelEl.style.display = "none";
      this.historyVisible = false;
    });

    // Help card dismiss handlers
    this.helpCard.querySelector("#help-card-close")!.addEventListener("click", () => {
      this.hideHelpCard();
    });

    // Clicking outside the help card dismisses it (the overlay itself)
    this.helpCard.addEventListener("click", (e: MouseEvent) => {
      if (e.target === this.helpCard) {
        this.hideHelpCard();
      }
    });

    // Escape dismisses help card
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.helpCard.style.display !== "none") {
        this.hideHelpCard();
      }
    });

    // Auto-show help on first visit (versioned so it re-shows after text changes)
    this.autoShowHelpIfNew();

    this.waypointInputBtn.addEventListener("click", () => this.onWaypointInputSubmit());
    this.waypointInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.onWaypointInputSubmit();
      }
    });

    state.subscribe(() => this.render());
    this.render();
  }

  private async onWaypointInputSubmit() {
    const raw = this.waypointInputEl.value.trim();

    // If input is empty and pin mode is available, start pin-dropper mode
    if (!raw) {
      this.startPinDrop();
      return;
    }

    if (this.isAddingWaypoint) return;

    this.isAddingWaypoint = true;
    this.waypointInputBtn.disabled = true;
    this.waypointInputBtn.textContent = "…";

    try {
      let coords: ParsedCoords | null = null;

      if (isGoogleShortLink(raw)) {
        coords = await resolveShortLink(raw);
        if (!coords) {
          showToast(strings.sidebar.cantResolveLink, "error");
          return;
        }
      } else {
        const refLat = this.state.location?.lat;
        const refLon = this.state.location?.lon;
        coords = parseInput(raw, refLat, refLon);

        if (!coords && looksLikePlusCode(raw) && (refLat === undefined || refLon === undefined)) {
          showToast(strings.sidebar.shortPlusCodeNeedsRef, "error");
          return;
        }

        if (!coords) {
          showToast(strings.sidebar.cantParseInput, "error");
          return;
        }
      }

      const { lat, lon } = coords;
      const label = (await reverseGeocode(lat, lon)) ?? strings.sidebar.stopLabel(this.state.waypoints.length + 1);
      this.onSend({ type: "add_waypoint", lat, lon, label });
      this.waypointInputEl.value = "";
      showToast(strings.sidebar.addedToast(label), "success");
    } finally {
      this.isAddingWaypoint = false;
      this.waypointInputBtn.disabled = false;
      this.waypointInputBtn.textContent = "+";
    }
  }

  private async onAddStreamerPosition() {
    const loc = this.state.location;
    if (!loc) return;

    const now = Date.now();
    if (now - this.lastAddPositionTime < 5000) {
      showToast(strings.sidebar.waitBeforeAdding, "error");
      return;
    }
    this.lastAddPositionTime = now;

    const lat = loc.lat;
    const lon = loc.lon;
    const geocoded = await reverseGeocode(lat, lon);
    const name = loc.display_name ?? "streamer";
    const label = geocoded ?? name;

    // Add the waypoint — server will assign an ID; we wait for the waypoint_list
    // response which will contain the new waypoint, then reorder.
    // Strategy: optimistically snapshot current IDs, send add_waypoint, then on
    // the next waypoint_list we'll detect the new ID and reorder.
    // Simpler: send add_waypoint then immediately send reorder with the new id first.
    // But we don't know the new ID yet. So we use a one-shot subscriber approach.
    const prevIds = new Set(this.state.waypoints.map((w) => w.id));

    this.onSend({ type: "add_waypoint", lat, lon, label });

    // Wait for the server to echo back the updated waypoint list with the new ID
    const unsubscribe = this.state.subscribeOnce(() => {
      const newWp = this.state.waypoints.find((w) => !prevIds.has(w.id));
      if (newWp) {
        const ordered_ids = [
          newWp.id,
          ...this.state.waypoints.filter((w) => w.id !== newWp.id).map((w) => w.id),
        ];
        this.onSend({ type: "reorder_waypoints", ordered_ids });
      }
      unsubscribe();
    });
  }

  /** Render social links bar. Call this after updating state.socialLinks. */
  renderSocialLinks() {
    const { discord, kick, twitch } = this.state.socialLinks;
    const links: { href: string; label: string; icon: string }[] = [];

    if (discord) {
      links.push({ href: "/discord", label: strings.social.discord, icon: strings.social.discordIcon });
    }
    if (kick) {
      links.push({ href: kick, label: strings.social.kick, icon: strings.social.kickIcon });
    }
    if (twitch) {
      links.push({ href: twitch, label: strings.social.twitch, icon: strings.social.twitchIcon });
    }

    if (links.length === 0) {
      this.socialLinksEl.innerHTML = "";
      return;
    }

    this.socialLinksEl.innerHTML = links.map((l) =>
      `<a class="social-link" href="${l.href}" target="_blank" rel="noopener noreferrer">${l.icon} ${l.label}</a>`
    ).join("");
  }

  private render() {
    const waypoints = this.state.waypoints;
    const loc = this.state.location;

    // Update connection status
    this.statusDot.className = `connection-status ${this.state.connected ? "connected" : "disconnected"}`;
    this.statusDot.title = this.state.connected ? strings.sidebar.connected : strings.sidebar.disconnected;

    // Update streamer status bar
    if (this.state.live) {
      this.streamerStatusEl.textContent = strings.sidebar.streamerLive;
      this.streamerStatusEl.className = "streamer-status streamer-live";
      this.addPositionBtn.style.display = loc ? "block" : "none";
    } else {
      this.streamerStatusEl.textContent = strings.sidebar.streamerOffline;
      this.streamerStatusEl.className = "streamer-status streamer-offline";
      this.addPositionBtn.style.display = "none";
    }

    // Enable/disable delete-all based on whether there are waypoints
    this.deleteAllBtn.disabled = waypoints.length === 0;

    // Rebuild waypoint list
    if (waypoints.length === 0) {
      const hint = this.isPinMode
        ? strings.sidebar.emptyStatePinMode
        : this.isTouch
          ? strings.sidebar.emptyStateMobile
          : strings.sidebar.emptyStateDesktop;
      this.listEl.innerHTML = `
        <div class="empty-state">
          ${hint}
        </div>
      `;
      this.sortable?.destroy();
      this.sortable = null;
    } else {
      this.listEl.innerHTML = waypoints
        .map(
          (wp, i) => {
            const isFirst = i === 0;
            const isLast = i === waypoints.length - 1;
            const multipleWaypoints = waypoints.length > 1;
            return `
        <div class="waypoint-item ${wp.active === false ? "waypoint-inactive" : ""}" data-id="${wp.id}">
          <span class="waypoint-index">${i + 1}</span>
          <div class="waypoint-info">
            <div class="waypoint-label" data-id="${wp.id}" title="${strings.waypoint.labelEditTitle}">${escapeHtml(wp.label)}</div>
            <div class="waypoint-coords">${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)}${wp.active === false ? ` \u00B7 ${strings.waypoint.inactive}` : ""}</div>
            <div class="waypoint-actions-row">
              ${multipleWaypoints && !isFirst ? `<button class="wp-action-btn wp-set-start" data-id="${wp.id}" title="${strings.waypoint.startTitle}">${strings.waypoint.start}</button>` : ""}
              ${multipleWaypoints && !isLast ? `<button class="wp-action-btn wp-set-end" data-id="${wp.id}" title="${strings.waypoint.endTitle}">${strings.waypoint.end}</button>` : ""}
              <button class="wp-action-btn wp-toggle-active" data-id="${wp.id}" data-active="${wp.active !== false}" title="${wp.active === false ? strings.waypoint.includeTitle : strings.waypoint.excludeTitle}">${wp.active === false ? strings.waypoint.activate : strings.waypoint.deactivate}</button>
              <button class="wp-action-btn wp-open-gmaps" data-lat="${wp.lat}" data-lon="${wp.lon}" title="${strings.waypoint.mapsTitle}">${strings.waypoint.maps}</button>
            </div>
          </div>
          <button class="waypoint-remove" data-id="${wp.id}" title="Remove">&times;</button>
        </div>
      `;}
        )
        .join("");

      // Remove button handlers
      this.listEl.querySelectorAll(".waypoint-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id!;
          this.onSend({ type: "remove_waypoint", id });
        });
      });

      // Set-as-start handlers
      this.listEl.querySelectorAll(".wp-set-start").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id!;
          const allIds = this.state.waypoints.map((w) => w.id);
          const ordered = [id, ...allIds.filter((wid) => wid !== id)];
          this.onSend({ type: "reorder_waypoints", ordered_ids: ordered });
        });
      });

      // Set-as-end handlers
      this.listEl.querySelectorAll(".wp-set-end").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).dataset.id!;
          const allIds = this.state.waypoints.map((w) => w.id);
          const ordered = [...allIds.filter((wid) => wid !== id), id];
          this.onSend({ type: "reorder_waypoints", ordered_ids: ordered });
        });
      });

      // Active/inactive handlers
      this.listEl.querySelectorAll(".wp-toggle-active").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = btn as HTMLElement;
          const id = el.dataset.id!;
          const currentlyActive = el.dataset.active === "true";
          this.onSend({ type: "set_waypoint_active", id, active: !currentlyActive });
        });
      });

      // Open in Google Maps handlers
      this.listEl.querySelectorAll(".wp-open-gmaps").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = btn as HTMLElement;
          window.open(`https://www.google.com/maps?q=${el.dataset.lat},${el.dataset.lon}`, "_blank");
        });
      });

      // Inline label editing
      this.listEl.querySelectorAll(".waypoint-label").forEach((labelEl) => {
        labelEl.addEventListener("click", (e) => {
          e.stopPropagation();
          this.startLabelEdit(labelEl as HTMLElement);
        });
      });

      // Setup drag-to-reorder — drag by the left number/handle region,
      // click everything else (label to edit, buttons to act).
      this.sortable?.destroy();
      this.sortable = Sortable.create(this.listEl, {
        animation: 150,
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        dragClass: "sortable-drag",
        handle: ".waypoint-index",
        onEnd: () => {
          const items = this.listEl.querySelectorAll(".waypoint-item");
          const ordered_ids = Array.from(items).map(
            (el) => (el as HTMLElement).dataset.id!
          );
          this.onSend({ type: "reorder_waypoints", ordered_ids });
        },
      });
    }

    // Render route info (summary + maneuvers)
    this.renderRouteInfo();
  }

  private startLabelEdit(labelEl: HTMLElement) {
    const id = labelEl.dataset.id!;
    const currentText = labelEl.textContent ?? "";

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentText;
    input.className = "waypoint-label-input";

    const commit = () => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== currentText) {
        this.onSend({ type: "rename_waypoint", id, label: newLabel });
      }
      // The server will broadcast the updated list; render() will replace the input
      // with the new label. If the user cancelled we restore manually.
      if (!newLabel || newLabel === currentText) {
        labelEl.textContent = currentText;
        input.replaceWith(labelEl);
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        input.value = currentText; // revert
        input.blur();
      }
    });

    // Prevent sortable drag from starting when interacting with input
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("touchstart", (e) => e.stopPropagation());

    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  private renderRouteInfo() {
    const route = this.state.route;
    const live = this.state.liveRoute;

    if (!route) {
      if (this.state.waypoints.length >= 2) {
        this.routeInfoEl.innerHTML = `<div class="route-calculating">${strings.route.calculating}</div>`;
      } else {
        this.routeInfoEl.innerHTML = "";
      }
      return;
    }

    let html = `
      <div class="route-summary">
        ${strings.route.summary(route.distance_km.toFixed(1), String(Math.round(route.duration_min)))}
      </div>
    `;

    // Live ETA section — shown when we have a live route result
    if (live) {
      const saved = route.duration_min - live.duration_min;
      const savedPct = route.distance_km > 0
        ? Math.round((1 - live.distance_km / route.distance_km) * 100)
        : 0;
      html += `
        <div class="live-eta">
          <div class="live-eta-header">
            <span class="live-dot"></span>
            ${strings.route.liveEtaHeader}
          </div>
          <div class="live-eta-stats">
            <span>${strings.route.kmLeft(live.distance_km.toFixed(1))}</span>
            <span>&middot;</span>
            <span>${strings.route.minutes(String(Math.round(live.duration_min)))}</span>
            <span>&middot;</span>
            <span>${strings.route.speed(live.speed_kmh.toFixed(1))}</span>
          </div>
          ${saved > 0.5 ? `<div class="live-eta-saved">${strings.route.saved(savedPct, Math.round(saved))}</div>` : ""}
        </div>
      `;
    }

    html += `<div class="maneuver-list">`;

    // Show live route legs if available (from current position), otherwise static route
    const legsToShow = live ? live.legs : route.legs;
    for (let legIdx = 0; legIdx < legsToShow.length; legIdx++) {
      const leg = legsToShow[legIdx];

      if (legsToShow.length > 1) {
        html += `<div class="leg-divider">${strings.route.legDivider(legIdx + 1, leg.distance_km.toFixed(1))}</div>`;
      }

      for (const m of leg.maneuvers) {
        html += this.renderManeuver(m);
      }
    }

    html += `</div>`;
    this.routeInfoEl.innerHTML = html;
  }

  private renderManeuver(m: Maneuver): string {
    const icon = maneuverIcon(m.maneuver_type);
    const dist = formatDistance(m.distance_km);
    const streets = m.street_names?.length ? m.street_names.join(", ") : "";

    return `
      <div class="maneuver-item">
        <span class="maneuver-icon">${icon}</span>
        <div class="maneuver-body">
          <div class="maneuver-instruction">${escapeHtml(m.instruction)}</div>
          ${streets ? `<div class="maneuver-street">${escapeHtml(streets)}</div>` : ""}
        </div>
        ${dist ? `<span class="maneuver-dist">${dist}</span>` : ""}
      </div>
    `;
  }

  // --- Help card --- (public entry points for the help toggle button)

  private static readonly HELP_VERSION = 1;
  private static readonly HELP_SEEN_KEY = "katmap-help-seen-version";

  toggleHelpCard() {
    if (this.helpCard.style.display !== "none") {
      this.hideHelpCard();
    } else {
      this.showHelpCard();
    }
  }

  private showHelpCard() {
    this.helpCard.style.display = "";  // remove inline display so CSS .help-overlay's flex takes over
    this.markHelpSeen();
  }

  private hideHelpCard() {
    this.helpCard.style.display = "none";
    this.markHelpSeen();
  }

  /** Bump HELP_VERSION to re-show the card for everyone. */
  private markHelpSeen() {
    try {
      localStorage.setItem(Sidebar.HELP_SEEN_KEY, String(Sidebar.HELP_VERSION));
    } catch { /* ignore */ }
  }

  private autoShowHelpIfNew() {
    let storedVersion = 0;
    try {
      storedVersion = parseInt(localStorage.getItem(Sidebar.HELP_SEEN_KEY) ?? "", 10) || 0;
    } catch { /* ignore */ }
    if (storedVersion < Sidebar.HELP_VERSION) {
      this.showHelpCard();
    }
  }

  // --- Pin dropper ---

  private startPinDrop() {
    if (this.enterPinMode) {
      this.isPinMode = true;
      this.enterPinMode();
      this.render();
    }
  }

  stopPinDrop() {
    if (this.exitPinMode) {
      this.isPinMode = false;
      this.exitPinMode();
      this.render();
    }
  }

  private renderHistoryList() {
    const streams = this.state.historyStreams;

    if (streams.length === 0) {
      this.historyListEl.innerHTML = `<div class="empty-state">${strings.history.empty}</div>`;
      return;
    }

    const selectedId = this.state.selectedHistoryId;

    this.historyListEl.innerHTML = streams.map((entry) => {
      const startDate = new Date(entry.started_at);
      const dateStr = startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const timeStr = startDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const durationMs = entry.ended_at - entry.started_at;
      const durationMin = Math.round(durationMs / 60000);
      const isSelected = entry.id === selectedId;
      const pointCount = entry.breadcrumbs.length;

      return `
        <div class="history-item ${isSelected ? "history-item-selected" : ""}" data-id="${entry.id}">
          <div class="history-item-header">
            <span class="history-date">${dateStr} ${timeStr}</span>
            <span class="history-platform">${entry.platform}</span>
          </div>
          ${entry.stream_title ? `<div class="history-title">${escapeHtml(entry.stream_title)}</div>` : ""}
          <div class="history-meta">${strings.history.meta(pointCount, durationMin)}</div>
        </div>
      `;
    }).join("");

    this.historyListEl.querySelectorAll(".history-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = Number((el as HTMLElement).dataset.id);
        if (this.state.selectedHistoryId === id) {
          this.state.selectHistoryStream(null);
        } else {
          this.state.selectHistoryStream(id);
        }
        this.renderHistoryList();
      });
    });
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Toast helper (mirrors any existing toast in main.ts if present)
function showToast(message: string, kind: "error" | "success" | "info" = "info") {
  let el = document.getElementById("toast-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast-${kind}`;
  el.classList.add("toast-visible");
  setTimeout(() => el!.classList.remove("toast-visible"), 3000);
}

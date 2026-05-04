/**
 * Settings popup for KatMap main page.
 *
 * Provides map theme selection and per-measurement unit toggles.
 */

import { AppState } from "./state";
import { UserUnits, UnitSystem } from "./units";
import { Theme, THEMES } from "./themes";
import { strings } from "./strings";

export class SettingsPopup {
  private overlay: HTMLElement;
  private card: HTMLElement;
  private state: AppState;
  private onThemeChange: (theme: Theme) => void;
  private getCurrentTheme: () => Theme;

  constructor(
    state: AppState,
    onThemeChange: (theme: Theme) => void,
    getCurrentTheme: () => Theme,
  ) {
    this.state = state;
    this.onThemeChange = onThemeChange;
    this.getCurrentTheme = getCurrentTheme;

    // Build overlay
    this.overlay = document.createElement("div");
    this.overlay.className = "settings-overlay";
    this.overlay.style.display = "none";
    document.body.appendChild(this.overlay);

    // Build card
    this.card = document.createElement("div");
    this.card.className = "settings-card";
    this.overlay.appendChild(this.card);

    this.render();
    this.attachEvents();
  }

  private render() {
    const units = this.state.units;
    const currentTheme = this.getCurrentTheme();

    this.card.innerHTML = `
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close" title="Close">&times;</button>
      </div>

      <div class="settings-section">
        <h3>Map Theme</h3>
        <select class="settings-theme-select">
          ${THEMES.map(t => `<option value="${t}" ${t === currentTheme ? "selected" : ""}>${strings.themes[t as keyof typeof strings.themes]}</option>`).join("")}
        </select>
      </div>

      <div class="settings-section">
        <h3>Units</h3>
        <div class="settings-unit-row">
          <span class="settings-unit-label">Distance</span>
          <div class="settings-unit-toggle" data-unit="distance">
            <button class="unit-opt ${units.distance === "metric" ? "active" : ""}" data-value="metric">km / m</button>
            <button class="unit-opt ${units.distance === "imperial" ? "active" : ""}" data-value="imperial">mi / ft</button>
          </div>
        </div>
        <div class="settings-unit-row">
          <span class="settings-unit-label">Speed</span>
          <div class="settings-unit-toggle" data-unit="speed">
            <button class="unit-opt ${units.speed === "metric" ? "active" : ""}" data-value="metric">km/h</button>
            <button class="unit-opt ${units.speed === "imperial" ? "active" : ""}" data-value="imperial">mph</button>
          </div>
        </div>
        <div class="settings-unit-row">
          <span class="settings-unit-label">Altitude</span>
          <div class="settings-unit-toggle" data-unit="altitude">
            <button class="unit-opt ${units.altitude === "metric" ? "active" : ""}" data-value="metric">m</button>
            <button class="unit-opt ${units.altitude === "imperial" ? "active" : ""}" data-value="imperial">ft</button>
          </div>
        </div>
      </div>
    `;
  }

  private attachEvents() {
    // Close button
    this.card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("settings-close")) {
        this.hide();
      }
    });

    // Click overlay background to close
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.hide();
    });

    // Theme change
    this.card.addEventListener("change", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("settings-theme-select")) {
        const theme = (target as HTMLSelectElement).value as Theme;
        this.onThemeChange(theme);
      }
    });

    // Unit toggles
    this.card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("unit-opt")) return;

      const toggle = target.closest(".settings-unit-toggle") as HTMLElement;
      if (!toggle) return;

      const unitKey = toggle.dataset.unit as keyof UserUnits;
      const value = target.dataset.value as UnitSystem;

      // Update toggle button styles
      toggle.querySelectorAll(".unit-opt").forEach(btn => btn.classList.remove("active"));
      target.classList.add("active");

      // Update state
      const newUnits = { ...this.state.units, [unitKey]: value };
      this.state.setUnits(newUnits);
    });
  }

  show() {
    this.render();
    this.overlay.style.display = "";
  }

  hide() {
    this.overlay.style.display = "none";
  }

  toggle() {
    if (this.overlay.style.display === "none") {
      this.show();
    } else {
      this.hide();
    }
  }

  /** Re-render the card contents (e.g. after theme or unit changes). */
  refresh() {
    // Preserve the scroll position and re-render
    this.render();
  }
}

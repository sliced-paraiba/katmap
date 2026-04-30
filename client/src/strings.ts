/**
 * Centralized UI strings for KatMap.
 *
 * Edit this file to customise labels, messages, and other user-facing text.
 * All other source files reference this object instead of hardcoding strings.
 */
export const strings = {
  /** App-wide */
  app: {
    title: "KatMap",
  },

  /** Sidebar */
  sidebar: {
    headerTitle: "KatMap",
    connected: "Connected",
    disconnected: "Disconnected",
    streamerLive: "Streamer is live",
    streamerOffline: "Streamer is offline",
    addStreamerLocation: "+ Add streamer location",
    undo: "\u21B6 Undo",
    undoTitle: "Undo (Ctrl+Z)",
    deleteAll: "\u2715 Delete all",
    deleteAllTitle: "Delete all waypoints",
    history: "\uD83D\uDCC1 History",
    historyTitle: "Browse past streams",
    pastStreams: "Past Streams",
    emptyStateDesktop:
      "Right-click the map or use the input above to add waypoints.<br>Drag waypoints to reorder. Route calculates automatically.",
    emptyStateMobile:
      "Long-press the map or use the input above to add waypoints.<br>Drag waypoints to reorder. Route calculates automatically.",
    emptyStatePinMode: "Click the map to place a waypoint\u2026",
    helpDismiss: "\u2715",
    helpDismissTitle: "Dismiss (click outside or press Esc likewise)",
    inputPlaceholder: "lat, lon \u00A0\u2022\u00A0 Plus code \u00A0\u2022\u00A0 Maps link",
    inputTitle: "Add waypoint by coordinates, Plus Code, or Google Maps URL",
    inputButton: "+",
    inputButtonTitle: "Add waypoint",
    stopLabel: (n: number) => `Stop ${n}`,
    addedToast: (label: string) => `Added: ${label}`,
    cantResolveLink: "Couldn't resolve that Google Maps link",
    shortPlusCodeNeedsRef:
      "Short Plus Codes need a reference location — streamer must be live",
    cantParseInput: "Couldn't parse that — try lat, lon or a Google Maps link",
    waitBeforeAdding: "Wait a moment before adding again",
  },

  /** Waypoint list items */
  waypoint: {
    inactive: "inactive",
    start: "\u25B2 Start",
    end: "\u25BC End",
    startTitle: "Set as start",
    endTitle: "Set as end",
    activate: "Activate",
    deactivate: "Deactivate",
    includeTitle: "Include in route",
    excludeTitle: "Exclude from route",
    maps: "\uD83D\uDDFA\uFE0F Maps",
    mapsTitle: "Open in Google Maps",
    removeTitle: "Remove",
    labelEditTitle: "Click to rename",
  },

  /** Route info */
  route: {
    calculating: "Calculating route...",
    /** Format: "{km} km · {min} min" */
    summary: (km: string, min: string) => `${km} km \u00B7 ${min} min`,
    liveEtaHeader: "Live ETA",
    /** Format: "{km} km left" */
    kmLeft: (km: string) => `${km} km left`,
    /** Format: "{min} min" */
    minutes: (min: string) => `${min} min`,
    /** Format: "{kmh} km/h" */
    speed: (kmh: string) => `${kmh} km/h`,
    /** Format: "{pct}% complete, {min} min saved" */
    saved: (pct: number, min: number) =>
      `${pct}% complete, ${min} min saved`,
    /** Format: "Leg {n} · {km} km" */
    legDivider: (n: number, km: string) =>
      `Leg ${n} \u00B7 ${km} km`,
  },

  /** Context menu (map right-click / long-press) */
  contextMenu: {
    addWaypointHere: "Add waypoint here",
    setAsStart: "Set as start",
    setAsEnd: "Set as end",
    markInactive: "Mark inactive",
    markActive: "Mark active",
    openInGoogleMaps: "Open in Google Maps",
    deleteNode: "Delete node",
  },

  /** History panel */
  history: {
    empty: "No past streams recorded yet.",
    /** Format: "{points} points · {min} min" */
    meta: (points: number, min: number) =>
      `${points} points \u00B7 ${min} min`,
  },

  /** Social links */
  social: {
    discord: "Discord",
    discordIcon: "\uD83D\uDCAC",
    kick: "Kick",
    kickIcon: "\u25B6\uFE0F",
    twitch: "Twitch",
    twitchIcon: "\uD83D\uDCFA",
  },

  /** Map controls */
  map: {
    menuButton: "\u2630",
    followButton: "\u2316",
    followTitle: "Follow streamer",
    themeTitle: "Map style",
    userCountTitle: "Connected users",
    /** Fallback stop label for reverse geocode */
    fallbackStopLabel: (n: number) => `Stop ${n}`,
  },

  /** Theme select labels — these appear in the HTML <option> elements */
  themes: {
    dark: "Dark Matter",
    light: "Positron",
    bright: "OSM Bright",
    fiord: "Fiord Color",
    toner: "Toner",
    basic: "Basic",
    neon: "Neon Night",
    midnight: "Midnight Blue",
    raster: "Raster (OSM)",
  },

  /** Overlay (OBS browser source) */
  overlay: {
    title: "KatMap Overlay",
    waitingForGps: "Waiting for GPS",
    liveGps: "Live GPS",
    offline: "Offline",
    /** Format: "GPS stale {seconds}s" */
    staleGps: (seconds: number) => `GPS stale ${seconds}s`,
    /** Format: "{speed} km/h" */
    speed: (speed: string) => `${speed} km/h`,
    /** Format: "{altitude} m alt" */
    altitude: (alt: string) => `${alt} m alt`,
    /** Format: "ETA {eta}" */
    etaLabel: (eta: string) => `ETA ${eta}`,
    etaUnknown: "--",
    speedUnknown: "-- km/h",
    altUnknown: "-- m alt",
    coordsUnknown: "--, --",
  },

  /** Toast / connection messages */
  toast: {
    disconnected: "Disconnected from server. Reconnecting...",
    connected: "Connected",
  },

  /** First-time help / onboarding card */
  help: {
    triggerLabel: "\u2753 Help",
    triggerTitle: "Show help card",
    heading: "Welcome to KatMap!",
    intro: "A live collaborative route planner for streamers and their community.",
    addTitle: "Adding Waypoints",
    addDetailsDesktop:
      "Right-click the map and choose <em>Add waypoint here</em>, or paste coordinates / Plus Codes / Google Maps links into the input box above.",
    addDetailsMobile:
      "Long-press the map and choose <em>Add waypoint here</em>, or paste coordinates / Plus Codes / Google Maps links into the input box above.",
    reorderTitle: "Reordering",
    reorderDetails:
      "Drag items in the sidebar up or down, or right-click a waypoint on the map and choose <em>Set as start</em> / <em>Set as end</em>.",
    autoRoute: "The route recalculates automatically when anything changes.",
    activeTitle: "Active &amp; Inactive",
    activeDetails:
      "Waypoints can be made <em>inactive</em> for planning without affecting the route. Right-click a waypoint or use the sidebar toggle to activate / deactivate.",
    liveEtaTitle: "Live ETA",
    liveEtaDetails:
      "When the streamer is live, a <em>Live ETA</em> section appears below the route summary. It estimates remaining distance and time using the streamer\u2019s current speed.",
    undoTitle: "Undo",
    undoDetails:
      "Made a mistake? Press Ctrl+Z or click the <em>Undo</em> button. Also works after auto-deactivating reached waypoints.",
    historyTitle: "History",
    historyDetails:
      "Click <em>History</em> to browse past sessions. Each entry shows where the streamer went with a breadcrumb trail.",
    farewell: "Have fun \u2014 and walk safe! \u{1F44B}",
  },
} as const;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Waypoint {
    pub id: Uuid,
    pub lat: f64,
    pub lon: f64,
    pub label: String,
}

/// A single breadcrumb point with optional GeolocationCoordinates telemetry.
/// Stored in the trail accumulator and persisted to SQLite telemetry column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreadcrumbPoint {
    /// GPS timestamp in milliseconds — used to sort out-of-order arrivals.
    #[serde(default)]
    pub timestamp_ms: i64,
    pub lon: f64,
    pub lat: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude_accuracy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteLeg {
    pub start_waypoint_id: Uuid,
    pub end_waypoint_id: Uuid,
    pub distance_km: f64,
    pub duration_min: f64,
    pub maneuvers: Vec<Maneuver>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Maneuver {
    pub instruction: String,
    pub distance_km: f64,
    pub duration_min: f64,
    /// Valhalla maneuver type (0=None, 1=Start, 9=SlightRight, 10=Right, 15=Left, etc.)
    pub maneuver_type: u32,
    /// Street names for this segment
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub street_names: Vec<String>,
    /// Index into decoded polyline where this maneuver starts
    pub begin_shape_index: u32,
    /// Index into decoded polyline where this maneuver ends
    pub end_shape_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    AddWaypoint {
        lat: f64,
        lon: f64,
        label: String,
    },
    RemoveWaypoint {
        id: Uuid,
    },
    MoveWaypoint {
        id: Uuid,
        lat: f64,
        lon: f64,
    },
    RenameWaypoint {
        id: Uuid,
        label: String,
    },
    ReorderWaypoints {
        ordered_ids: Vec<Uuid>,
    },
    RequestRoute,
    /// Route from the streamer's current live position through remaining waypoints.
    /// Uses the actual GPS speed if available, otherwise falls back to WALKING_SPEED_KMH.
    RequestLiveRoute,
    /// Delete all waypoints (pushes undo entry first)
    DeleteAll,
    /// Undo the last mutating operation
    Undo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    WaypointList {
        waypoints: Vec<Waypoint>,
    },
    UserCount {
        count: usize,
    },
    RouteResult {
        polyline: String,
        distance_km: f64,
        duration_min: f64,
        legs: Vec<RouteLeg>,
    },
    /// Server-driven location update (from companion app)
    Location {
        lat: f64,
        lon: f64,
        timestamp_ms: i64,
        display_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        altitude: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        accuracy: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        altitude_accuracy: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        heading: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        speed: Option<f64>,
    },
    /// Server-driven breadcrumb trail update (from companion app)
    Trail {
        coords: Vec<[f64; 2]>,
    },
    /// Session live status (from companion app)
    LiveStatus {
        live: bool,
    },
    /// Live route result: routed from streamer's current position through remaining waypoints.
    /// Uses actual GPS speed. Separate from RouteResult so clients can display both.
    LiveRouteResult {
        polyline: String,
        distance_km: f64,
        duration_min: f64,
        legs: Vec<RouteLeg>,
        /// Current speed used for the calculation (km/h)
        speed_kmh: f64,
    },
    Error {
        message: String,
    },
}

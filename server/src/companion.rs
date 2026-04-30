use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tokio::time::{Duration, Instant};

use crate::history::{mark_trail_complete, save_stream_internal, upsert_incomplete_trail};
use crate::types::BreadcrumbPoint;
use crate::ws::AppState;

const STALE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STALE_CHECK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LocationPush {
    Location {
        lat: f64,
        lon: f64,
        #[serde(default)]
        timestamp_ms: Option<i64>,
        #[serde(default)]
        altitude: Option<f64>,
        #[serde(default)]
        accuracy: Option<f64>,
        #[serde(default)]
        altitude_accuracy: Option<f64>,
        #[serde(default)]
        heading: Option<f64>,
        #[serde(default)]
        speed: Option<f64>,
    },
    Stop,
}

#[derive(Clone, Default)]
pub(crate) struct TrailAccumulator {
    pub points: Vec<BreadcrumbPoint>,
    pub started_at: i64,
    pub last_location_ts: i64,
    pub incomplete_trail_id: Option<i64>,
    pub session_active: bool,
    /// Timestamp of last received location push (for stale detection).
    pub last_push_at: Option<Instant>,
    /// Human-readable session name (e.g. "streamer - 2026-04-15 14:30 UTC").
    pub session_name: String,
}

impl TrailAccumulator {
    /// Extract simple `[lon, lat]` coords from the breadcrumb points.
    pub fn coords(&self) -> Vec<[f64; 2]> {
        self.points.iter().map(|p| [p.lon, p.lat]).collect()
    }

    /// Insert a point and sort by timestamp. Returns `true` if the point
    /// arrived out of order (i.e. sorting changed the tail of the array).
    pub fn insert_sorted(&mut self, point: BreadcrumbPoint) -> bool {
        let ts = point.timestamp_ms;
        let was_tail = self
            .points
            .last()
            .map_or(true, |last| ts >= last.timestamp_ms);

        self.points.push(point);
        self.points.sort_by_key(|p| p.timestamp_ms);

        !was_tail
    }

    fn reset(&mut self) {
        self.points.clear();
        self.started_at = 0;
        self.last_location_ts = 0;
        self.incomplete_trail_id = None;
        self.session_active = false;
        self.last_push_at = None;
        self.session_name = String::new();
    }
}

pub async fn location_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(push): Json<LocationPush>,
) -> impl IntoResponse {
    // Auth check
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match auth {
        Some(token) if token == state.companion_api_key => {}
        _ => {
            return (StatusCode::UNAUTHORIZED, "Invalid or missing API key").into_response();
        }
    }

    crate::debug::record_location_push(&state.recent_location_pushes, push.clone()).await;

    match push {
        LocationPush::Location {
            lat,
            lon,
            timestamp_ms,
            altitude,
            accuracy,
            altitude_accuracy,
            heading,
            speed,
        } => {
            let (coords, need_upsert) = {
                let mut trail = state.trail.lock().await;

                if !trail.session_active {
                    // Auto-start session
                    let now = chrono::Utc::now().timestamp_millis();
                    trail.started_at = now;
                    trail.last_location_ts = now;
                    trail.incomplete_trail_id = None;
                    trail.session_active = true;
                    let dt = chrono::DateTime::from_timestamp_millis(now)
                        .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
                        .unwrap_or_else(|| now.to_string());
                    trail.session_name = format!("{} - {}", state.display_name, dt);
                    tracing::info!("companion: auto-starting session '{}' on first location push", trail.session_name);
                    let _ = state.tx.send(crate::types::ServerMessage::LiveStatus { live: true });
                }

                let ts = timestamp_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

                let out_of_order = trail.insert_sorted(BreadcrumbPoint {
                    timestamp_ms: ts,
                    lon,
                    lat,
                    altitude,
                    accuracy,
                    altitude_accuracy,
                    heading,
                    speed,
                });

                if out_of_order {
                    tracing::info!(
                        "companion: out-of-order point detected (ts={}), trail re-sorted",
                        ts
                    );
                }

                trail.last_location_ts = ts;
                trail.last_push_at = Some(Instant::now());

                let coords = trail.coords();
                let need_upsert = trail.started_at > 0
                    && trail.incomplete_trail_id.is_none()
                    && trail.session_active;
                (coords, need_upsert)
            }; // single lock released

            // Broadcast location with full telemetry
            let msg = crate::types::ServerMessage::Location {
                lat,
                lon,
                timestamp_ms: timestamp_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                display_name: Some(state.display_name.clone()),
                altitude,
                accuracy,
                altitude_accuracy,
                heading,
                speed,
            };
            let _ = state.tx.send(msg);

            // Update live location for live route requests
            {
                let mut loc = state.live_location.write().await;
                loc.lat = lat;
                loc.lon = lon;
                loc.speed = speed;
                loc.valid = true;
            }

            maybe_auto_complete_first_waypoint(&state, lat, lon).await;

            if coords.len() >= 2 {
                let _ = state.tx.send(crate::types::ServerMessage::Trail {
                    coords: coords.clone(),
                });
            }

            // Upsert to SQLite on first location of a new session
            if need_upsert {
                if let Some(history) = state.history {
                    let trail = state.trail.lock().await;
                    let streamer_id = state.display_name.clone();
                    let session_name = trail.session_name.clone();
                    let started_at = trail.started_at;
                    let coords_clone = trail.coords();
                    let telemetry_json = serde_json::to_string(&trail.points).ok();
                    drop(trail);

                    match upsert_incomplete_trail(
                        history,
                        &streamer_id,
                        "companion",
                        started_at,
                        &session_name,
                        &coords_clone,
                        telemetry_json.as_deref(),
                    )
                    .await
                    {
                        Ok(id) => {
                            let mut trail = state.trail.lock().await;
                            trail.incomplete_trail_id = Some(id);
                        }
                        Err(e) => tracing::warn!("companion: failed to upsert trail: {}", e),
                    }
                }
            }

            (StatusCode::OK, "Location recorded").into_response()
        }

        LocationPush::Stop => {
            {
                let trail = state.trail.lock().await;
                let snapshot = trail.clone();
                drop(trail);
                finalize_trail(&state, &snapshot, "stop").await;
            }

            state.trail.lock().await.reset();
            tracing::info!("companion: session stopped");
            let _ = state.tx.send(crate::types::ServerMessage::LiveStatus { live: false });

            (StatusCode::OK, "Session stopped").into_response()
        }
    }
}

/// Finalize a trail: save to SQLite and broadcast an empty trail to clear clients.
async fn finalize_trail(state: &AppState, trail: &TrailAccumulator, reason: &str) {
    if trail.points.is_empty() || trail.started_at == 0 {
        return;
    }

    let now = chrono::Utc::now().timestamp_millis();

    if let Some(history) = state.history {
        let coords = trail.coords();
        let telemetry_json = serde_json::to_string(&trail.points).ok();
        if let Some(id) = trail.incomplete_trail_id {
            let _ = mark_trail_complete(history, id, now, &coords, telemetry_json.as_deref()).await;
            tracing::info!(
                "companion: marked trail id={} complete ({}, {} coords)",
                id,
                reason,
                coords.len()
            );
        } else {
            let _ = save_stream_internal(
                history,
                &state.display_name,
                "companion",
                trail.started_at,
                now,
                &coords,
                telemetry_json.as_deref(),
            ).await;
        }
    }
}

async fn maybe_auto_complete_first_waypoint(state: &AppState, lat: f64, lon: f64) {
    if !state.auto_complete.enabled {
        return;
    }

    let first = { state.waypoints.read().await.first().cloned() };
    let Some(first) = first else {
        *state.auto_complete_candidate.lock().await = None;
        return;
    };

    let distance_m = haversine_m(lat, lon, first.lat, first.lon);
    if distance_m > state.auto_complete.radius_m {
        let mut candidate = state.auto_complete_candidate.lock().await;
        if candidate
            .as_ref()
            .is_some_and(|candidate| candidate.waypoint_id == first.id)
        {
            *candidate = None;
        }
        return;
    }

    let should_complete = {
        let mut candidate = state.auto_complete_candidate.lock().await;
        match candidate.as_ref() {
            Some(candidate)
                if candidate.waypoint_id == first.id
                    && candidate.since.elapsed() >= state.auto_complete.dwell =>
            {
                true
            }
            Some(candidate) if candidate.waypoint_id == first.id => false,
            _ => {
                *candidate = Some(crate::ws::AutoCompleteCandidate {
                    waypoint_id: first.id,
                    since: Instant::now(),
                });
                false
            }
        }
    };

    if !should_complete {
        return;
    }

    let mut wps = state.waypoints.write().await;
    if wps.first().is_some_and(|w| w.id == first.id) {
        crate::ws::push_undo(&state.undo_stack, &wps).await;
        let completed = wps.remove(0);
        tracing::info!(
            "auto-completed waypoint '{}' ({:.1}m away)",
            completed.label,
            distance_m
        );
        let _ = state.tx.send(crate::types::ServerMessage::WaypointList {
            waypoints: wps.clone(),
        });
    }
    *state.auto_complete_candidate.lock().await = None;
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

pub async fn status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match auth {
        Some(token) if token == state.companion_api_key => {}
        _ => return (StatusCode::UNAUTHORIZED, "Invalid or missing API key").into_response(),
    }

    let trail = state.trail.lock().await;
    if trail.session_active {
        Json(serde_json::json!({
            "live": true,
            "started_at": trail.started_at,
            "breadcrumb_count": trail.points.len(),
        }))
        .into_response()
    } else {
        Json(serde_json::json!({ "live": false })).into_response()
    }
}

/// Background task that checks for stale sessions (no location push for 15 min).
pub async fn stale_detector(state: AppState) {
    let mut interval = tokio::time::interval(STALE_CHECK_INTERVAL);

    loop {
        interval.tick().await;

        let should_finalize = {
            let trail = state.trail.lock().await;
            if !trail.session_active {
                false
            } else if let Some(last_push) = trail.last_push_at {
                last_push.elapsed() > STALE_TIMEOUT
            } else {
                false
            }
        };

        if should_finalize {
            tracing::info!("companion: stale session detected (no location for 15min), finalizing");

            {
                let trail = state.trail.lock().await;
                let snapshot = trail.clone();
                drop(trail);
                finalize_trail(&state, &snapshot, "stale").await;
            }

            state.trail.lock().await.reset();
            let _ = state.tx.send(crate::types::ServerMessage::LiveStatus { live: false });
        }
    }
}

/// Save any active trail on shutdown.
pub async fn save_on_shutdown(state: &AppState) {
    let trail = state.trail.lock().await;
    let snapshot = trail.clone();
    drop(trail);

    if snapshot.session_active && !snapshot.points.is_empty() {
        finalize_trail(state, &snapshot, "shutdown").await;
    }
}

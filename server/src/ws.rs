use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::time::{Duration, Instant};

use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use std::collections::HashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::companion::TrailAccumulator;
use crate::types::{ClientMessage, ServerMessage, Waypoint};

/// Last known streamer location pushed by the companion app.
#[derive(Clone, Default)]
pub struct LiveLocation {
    pub lat: f64,
    pub lon: f64,
    pub speed: Option<f64>,
    pub valid: bool,
}

pub type WaypointState = Arc<RwLock<Vec<Waypoint>>>;
pub type UndoStack = Arc<RwLock<Vec<Vec<Waypoint>>>>;
pub type ConnectedCount = Arc<AtomicUsize>;

#[derive(Clone)]
pub struct AutoCompleteConfig {
    pub enabled: bool,
    pub radius_m: f64,
    pub dwell: Duration,
}

#[derive(Clone)]
pub struct AutoCompleteCandidate {
    pub waypoint_id: Uuid,
    pub since: Instant,
}

/// Maximum number of undo entries kept in memory.
const UNDO_STACK_MAX: usize = 50;

#[derive(Clone, Default)]
pub struct SocialLinks {
    pub discord: Option<String>,
    pub kick: Option<String>,
    pub twitch: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub waypoints: WaypointState,
    pub undo_stack: UndoStack,
    pub tx: broadcast::Sender<ServerMessage>,
    pub connected_count: ConnectedCount,
    pub valhalla_url: String,
    pub walking_speed_kmh: f64,
    pub companion_api_key: String,
    pub display_name: String,
    pub avatar_path: String,
    pub history: Option<&'static crate::history::HistoryState>,
    pub social_links: SocialLinks,
    pub trail: Arc<Mutex<TrailAccumulator>>,
    pub live_location: Arc<RwLock<LiveLocation>>,
    pub snipe_route_limiter: Arc<crate::snipe::SnipeRouteLimiter>,
    pub recent_location_pushes: crate::debug::RecentLocationPushes,
    pub auto_complete: AutoCompleteConfig,
    pub auto_complete_candidate: Arc<Mutex<Option<AutoCompleteCandidate>>>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let counts_as_viewer = params.get("client").is_none_or(|client| client != "overlay");
    ws.on_upgrade(move |socket| handle_socket(socket, state, counts_as_viewer))
}

async fn handle_socket(socket: WebSocket, state: AppState, counts_as_viewer: bool) {
    let count = if counts_as_viewer {
        state.connected_count.fetch_add(1, Ordering::Relaxed) + 1
    } else {
        state.connected_count.load(Ordering::Relaxed)
    };
    tracing::info!(
        "WebSocket connection opened ({count} counted viewers, counts_as_viewer={counts_as_viewer})"
    );

    let (mut sink, mut stream) = socket.split();

    // Send current waypoint list as bootstrap
    {
        let waypoints = state.waypoints.read().await.clone();
        let msg = ServerMessage::WaypointList { waypoints };
        if let Ok(json) = serde_json::to_string(&msg) {
            if sink.send(Message::Text(json.into())).await.is_err() {
                if counts_as_viewer {
                    state.connected_count.fetch_sub(1, Ordering::Relaxed);
                }
                return;
            }
        }
    }

    // Send live status and last known location (so late-joining clients
    // see the streamer even if they connected mid-session)
    {
        let trail = state.trail.lock().await;
        if trail.session_active {
            let msg = ServerMessage::LiveStatus { live: true };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = sink.send(Message::Text(json.into())).await;
            }
            // Send last breadcrumb as a location update
            if let Some(pt) = trail.points.last() {
                let loc_msg = ServerMessage::Location {
                    lat: pt.lat,
                    lon: pt.lon,
                    timestamp_ms: trail.last_location_ts,
                    display_name: Some(state.display_name.clone()),
                    altitude: pt.altitude,
                    accuracy: pt.accuracy,
                    altitude_accuracy: pt.altitude_accuracy,
                    heading: pt.heading,
                    speed: pt.speed,
                };
                if let Ok(json) = serde_json::to_string(&loc_msg) {
                    let _ = sink.send(Message::Text(json.into())).await;
                }
            }
            // Send accumulated trail so late-joining clients see the breadcrumb line
            let coords = trail.coords();
            if coords.len() >= 2 {
                let trail_msg = ServerMessage::Trail { coords };
                if let Ok(json) = serde_json::to_string(&trail_msg) {
                    let _ = sink.send(Message::Text(json.into())).await;
                }
            }
        }
    }

    // Subscribe to broadcast channel for server -> client messages
    let mut rx = state.tx.subscribe();

    // Broadcast updated user count to all clients. Overlay connections receive the
    // count but do not increment it.
    if counts_as_viewer {
        let _ = state.tx.send(ServerMessage::UserCount { count });
    }

    // Task: forward broadcast messages to this client's WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sink.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    // Task: receive messages from this client and process them
    let tx = state.tx.clone();
    let waypoints = state.waypoints.clone();
    let undo_stack = state.undo_stack.clone();
    let valhalla_url = state.valhalla_url.clone();
    let walking_speed_kmh = state.walking_speed_kmh;
    let live_location = state.live_location.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    if let Err(e) =
                        handle_client_message(&text, &waypoints, &undo_stack, &tx, &valhalla_url, walking_speed_kmh, &live_location).await
                    {
                        tracing::warn!("Error handling client message: {e}");
                        let _ = tx.send(ServerMessage::Error {
                            message: e.to_string(),
                        });
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // If either task finishes, abort the other
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    if counts_as_viewer {
        let count = state.connected_count.fetch_sub(1, Ordering::Relaxed) - 1;
        tracing::info!("WebSocket connection closed ({count} counted viewers)");
        let _ = state.tx.send(ServerMessage::UserCount { count });
    } else {
        let count = state.connected_count.load(Ordering::Relaxed);
        tracing::info!(
            "Overlay WebSocket connection closed ({count} counted viewers unchanged)"
        );
    }
}

async fn handle_client_message(
    text: &str,
    waypoints: &WaypointState,
    undo_stack: &UndoStack,
    tx: &broadcast::Sender<ServerMessage>,
    valhalla_url: &str,
    walking_speed_kmh: f64,
    live_location: &Arc<RwLock<LiveLocation>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client_msg: ClientMessage = serde_json::from_str(text)?;

    match client_msg {
        ClientMessage::AddWaypoint { lat, lon, label } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            wps.push(Waypoint {
                id: Uuid::new_v4(),
                lat,
                lon,
                label,
                active: true,
            });
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::RemoveWaypoint { id } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            wps.retain(|w| w.id != id);
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::MoveWaypoint { id, lat, lon } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            if let Some(w) = wps.iter_mut().find(|w| w.id == id) {
                w.lat = lat;
                w.lon = lon;
            }
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::RenameWaypoint { id, label } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            if let Some(w) = wps.iter_mut().find(|w| w.id == id) {
                w.label = label;
            }
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::SetWaypointActive { id, active } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            if let Some(w) = wps.iter_mut().find(|w| w.id == id) {
                w.active = active;
            }
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::ReorderWaypoints { ordered_ids } => {
            let mut wps = waypoints.write().await;
            push_undo(undo_stack, &wps).await;
            let mut reordered = Vec::with_capacity(ordered_ids.len());
            for id in &ordered_ids {
                if let Some(w) = wps.iter().find(|w| &w.id == id) {
                    reordered.push(w.clone());
                }
            }
            for w in wps.iter() {
                if !ordered_ids.contains(&w.id) {
                    reordered.push(w.clone());
                }
            }
            *wps = reordered;
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::DeleteAll => {
            let mut wps = waypoints.write().await;
            if wps.is_empty() {
                return Ok(());
            }
            push_undo(undo_stack, &wps).await;
            wps.clear();
            let _ = tx.send(ServerMessage::WaypointList {
                waypoints: wps.clone(),
            });
        }
        ClientMessage::Undo => {
            let mut stack = undo_stack.write().await;
            if let Some(prev) = stack.pop() {
                tracing::info!("Undo: restoring {} waypoints", prev.len());
                let mut wps = waypoints.write().await;
                *wps = prev;
                let _ = tx.send(ServerMessage::WaypointList {
                    waypoints: wps.clone(),
                });
            } else {
                tracing::debug!("Undo: stack is empty");
            }
        }
        ClientMessage::RequestRoute => {
            let wps: Vec<_> = waypoints
                .read()
                .await
                .iter()
                .filter(|w| w.active)
                .cloned()
                .collect();
            if wps.len() < 2 {
                return Ok(());
            }
            let tx = tx.clone();
            let url = valhalla_url.to_string();
            tokio::spawn(async move {
                tracing::info!("Calculating route with {} active waypoints", wps.len());
                match crate::valhalla::calculate_route(&wps, &url, walking_speed_kmh).await {
                    Ok(result) => {
                        let _ = tx.send(ServerMessage::RouteResult {
                            polyline: result.polyline,
                            distance_km: result.distance_km,
                            duration_min: result.duration_min,
                            legs: result.legs,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("Route calculation failed: {e}");
                        let _ = tx.send(ServerMessage::Error { message: e });
                    }
                }
            });
        }
        ClientMessage::RequestLiveRoute => {
            let loc = live_location.read().await;
            if !loc.valid {
                return Ok(());
            }
            let origin_lat = loc.lat;
            let origin_lon = loc.lon;
            // GPS speed is in m/s — convert to km/h; fall back to configured default
            let speed_kmh = loc.speed.map(|s| s * 3.6).unwrap_or(walking_speed_kmh);
            drop(loc);

            let wps: Vec<_> = waypoints
                .read()
                .await
                .iter()
                .filter(|w| w.active)
                .cloned()
                .collect();
            if wps.is_empty() {
                return Ok(());
            }
            let remaining_wps = remaining_waypoints_for_live_route(origin_lat, origin_lon, &wps);
            if remaining_wps.is_empty() {
                return Ok(());
            }

            // Build a temporary waypoint list with a virtual waypoint 0 for the streamer.
            // Only include the route suffix that appears to be ahead of the streamer;
            // otherwise ETA can incorrectly route back to already-passed waypoints.
            let remaining_count = remaining_wps.len();
            let mut live_wps = vec![Waypoint {
                id: Uuid::new_v4(),
                lat: origin_lat,
                lon: origin_lon,
                label: "Live position".into(),
                active: true,
            }];
            live_wps.extend(remaining_wps);

            let tx = tx.clone();
            let url = valhalla_url.to_string();
            tokio::spawn(async move {
                tracing::info!("Calculating live route from ({}, {}) through {} remaining waypoints at {:.1} km/h", origin_lat, origin_lon, remaining_count, speed_kmh);
                match crate::valhalla::calculate_route(&live_wps, &url, speed_kmh).await {
                    Ok(result) => {
                        let _ = tx.send(ServerMessage::LiveRouteResult {
                            polyline: result.polyline,
                            distance_km: result.distance_km,
                            duration_min: result.duration_min,
                            legs: result.legs,
                            speed_kmh,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("Live route calculation failed: {e}");
                    }
                }
            });
        }
    }

    Ok(())
}

pub(crate) fn remaining_waypoints_for_live_route(
    origin_lat: f64,
    origin_lon: f64,
    waypoints: &[Waypoint],
) -> Vec<Waypoint> {
    if waypoints.len() <= 1 {
        return waypoints.to_vec();
    }

    let origin = (origin_lat, origin_lon);
    let mut best_segment_idx = 0usize;
    let mut best_t = 0.0;
    let mut best_distance_m = f64::INFINITY;

    for (idx, pair) in waypoints.windows(2).enumerate() {
        let a = (pair[0].lat, pair[0].lon);
        let b = (pair[1].lat, pair[1].lon);
        let (t, distance_m) = project_point_to_segment_m(origin, a, b);
        if distance_m < best_distance_m {
            best_distance_m = distance_m;
            best_segment_idx = idx;
            best_t = t;
        }
    }

    // If the streamer projects near/beyond the beginning of a segment, keep that
    // segment's start waypoint. Otherwise, the next waypoint is the remaining target.
    let start_idx = if best_t < 0.15 {
        best_segment_idx
    } else {
        best_segment_idx + 1
    };

    waypoints[start_idx.min(waypoints.len() - 1)..].to_vec()
}

fn project_point_to_segment_m(
    point: (f64, f64),
    segment_start: (f64, f64),
    segment_end: (f64, f64),
) -> (f64, f64) {
    let meters_per_deg_lat = 111_320.0;
    let ref_lat = ((point.0 + segment_start.0 + segment_end.0) / 3.0).to_radians();
    let meters_per_deg_lon = meters_per_deg_lat * ref_lat.cos().abs().max(0.01);

    let to_xy = |lat: f64, lon: f64| -> (f64, f64) {
        (
            (lon - point.1) * meters_per_deg_lon,
            (lat - point.0) * meters_per_deg_lat,
        )
    };

    let p = (0.0, 0.0);
    let a = to_xy(segment_start.0, segment_start.1);
    let b = to_xy(segment_end.0, segment_end.1);
    let ab = (b.0 - a.0, b.1 - a.1);
    let ap = (p.0 - a.0, p.1 - a.1);
    let ab_len2 = ab.0 * ab.0 + ab.1 * ab.1;
    if ab_len2 <= f64::EPSILON {
        return (0.0, (ap.0 * ap.0 + ap.1 * ap.1).sqrt());
    }

    let raw_t = (ap.0 * ab.0 + ap.1 * ab.1) / ab_len2;
    let t = raw_t.clamp(0.0, 1.0);
    let closest = (a.0 + ab.0 * t, a.1 + ab.1 * t);
    let dx = p.0 - closest.0;
    let dy = p.1 - closest.1;
    (t, (dx * dx + dy * dy).sqrt())
}

/// Push a snapshot of the current waypoints onto the undo stack, capping at UNDO_STACK_MAX.
pub(crate) async fn push_undo(undo_stack: &UndoStack, current: &[Waypoint]) {
    let mut stack = undo_stack.write().await;
    stack.push(current.to_vec());
    if stack.len() > UNDO_STACK_MAX {
        stack.remove(0);
    }
}

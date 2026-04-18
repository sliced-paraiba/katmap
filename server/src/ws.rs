use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::companion::TrailAccumulator;
use crate::types::{ClientMessage, ServerMessage, Waypoint};

pub type WaypointState = Arc<RwLock<Vec<Waypoint>>>;
pub type UndoStack = Arc<RwLock<Vec<Vec<Waypoint>>>>;
pub type ConnectedCount = Arc<AtomicUsize>;

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
    pub twitch: Option<crate::twitch::TwitchState>,
    pub history: Option<&'static crate::history::HistoryState>,
    pub social_links: SocialLinks,
    pub trail: Arc<Mutex<TrailAccumulator>>,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let count = state.connected_count.fetch_add(1, Ordering::Relaxed) + 1;
    tracing::info!("WebSocket connection opened ({count} connected)");

    let (mut sink, mut stream) = socket.split();

    // Send current waypoint list as bootstrap
    {
        let waypoints = state.waypoints.read().await.clone();
        let msg = ServerMessage::WaypointList { waypoints };
        if let Ok(json) = serde_json::to_string(&msg) {
            if sink.send(Message::Text(json.into())).await.is_err() {
                state.connected_count.fetch_sub(1, Ordering::Relaxed);
                return;
            }
        }
    }

    // Subscribe to broadcast channel for server -> client messages
    let mut rx = state.tx.subscribe();

    // Broadcast updated user count to all clients (new client receives it via rx)
    let _ = state.tx.send(ServerMessage::UserCount { count });

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
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    if let Err(e) =
                        handle_client_message(&text, &waypoints, &undo_stack, &tx, &valhalla_url, walking_speed_kmh).await
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

    let count = state.connected_count.fetch_sub(1, Ordering::Relaxed) - 1;
    tracing::info!("WebSocket connection closed ({count} connected)");
    let _ = state.tx.send(ServerMessage::UserCount { count });
}

async fn handle_client_message(
    text: &str,
    waypoints: &WaypointState,
    undo_stack: &UndoStack,
    tx: &broadcast::Sender<ServerMessage>,
    valhalla_url: &str,
    walking_speed_kmh: f64,
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
            let wps = waypoints.read().await.clone();
            let tx = tx.clone();
            let url = valhalla_url.to_string();
            tokio::spawn(async move {
                tracing::info!("Calculating route with {} waypoints", wps.len());
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
    }

    Ok(())
}

/// Push a snapshot of the current waypoints onto the undo stack, capping at UNDO_STACK_MAX.
async fn push_undo(undo_stack: &UndoStack, current: &[Waypoint]) {
    let mut stack = undo_stack.write().await;
    stack.push(current.to_vec());
    if stack.len() > UNDO_STACK_MAX {
        stack.remove(0);
    }
}

use std::collections::VecDeque;

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{companion::LocationPush, ws::AppState};

const MAX_RECENT_PUSHES: usize = 200;

pub type RecentLocationPushes = std::sync::Arc<Mutex<VecDeque<DebugLocationPush>>>;

#[derive(Debug, Clone, Serialize)]
pub struct DebugLocationPush {
    pub received_at_ms: i64,
    pub payload: LocationPush,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub commit: &'static str,
    pub build_time: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugSnapshot {
    pub version: VersionInfo,
    pub live: bool,
    pub started_at: Option<i64>,
    pub breadcrumb_count: usize,
    pub last_location_ts: Option<i64>,
    pub latest_push: Option<DebugLocationPush>,
    pub recent_pushes: Vec<DebugLocationPush>,
}

pub fn version_info() -> VersionInfo {
    VersionInfo {
        commit: env!("KATMAP_GIT_COMMIT"),
        build_time: env!("KATMAP_BUILD_TIME"),
    }
}

pub fn empty_recent_location_pushes() -> RecentLocationPushes {
    std::sync::Arc::new(Mutex::new(VecDeque::with_capacity(MAX_RECENT_PUSHES)))
}

pub async fn record_location_push(recent: &RecentLocationPushes, payload: LocationPush) {
    let mut pushes = recent.lock().await;
    if pushes.len() >= MAX_RECENT_PUSHES {
        pushes.pop_front();
    }
    pushes.push_back(DebugLocationPush {
        received_at_ms: chrono::Utc::now().timestamp_millis(),
        payload,
    });
}

fn unauthorized() -> axum::response::Response {
    (StatusCode::UNAUTHORIZED, "Invalid or missing debug token").into_response()
}

pub async fn version_handler() -> impl IntoResponse {
    Json(version_info())
}

pub async fn snapshot_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !crate::auth::is_admin_authorized(&headers, &state.companion_api_key) {
        return unauthorized();
    }

    let (live, started_at, breadcrumb_count, last_location_ts) = {
        let trail = state.trail.lock().await;
        (
            trail.session_active,
            trail.session_active.then_some(trail.started_at),
            trail.points.len(),
            (!trail.points.is_empty()).then_some(trail.last_location_ts),
        )
    };

    let recent_pushes: Vec<_> = state
        .recent_location_pushes
        .lock()
        .await
        .iter()
        .rev()
        .take(50)
        .cloned()
        .collect();
    let latest_push = recent_pushes.first().cloned();

    Json(DebugSnapshot {
        version: version_info(),
        live,
        started_at,
        breadcrumb_count,
        last_location_ts,
        latest_push,
        recent_pushes,
    })
    .into_response()
}

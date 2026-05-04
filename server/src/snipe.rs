use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

use crate::{
    valhalla::{self, Costing, RoutePoint},
    ws::AppState,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TravelMode {
    Car,
    Cycling,
    Walking,
}

impl TravelMode {
    fn costing(&self, walking_speed_kmh: f64) -> Costing {
        match self {
            TravelMode::Car => Costing::Auto,
            TravelMode::Cycling => Costing::Bicycle,
            TravelMode::Walking => Costing::Pedestrian { walking_speed_kmh },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SnipeRouteRequest {
    pub lat: f64,
    pub lon: f64,
    pub mode: TravelMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipeStatusResponse {
    pub live: bool,
    pub streamer: Option<SnipeLocation>,
    pub last_location_ts: Option<i64>,
    pub age_ms: Option<i64>,
    pub last_push_age_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipeLocation {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipeRouteResponse {
    pub streamer: SnipeLocation,
    pub polyline: String,
    pub distance_km: f64,
    pub duration_min: f64,
    pub maneuvers: Vec<SnipeManeuver>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipeManeuver {
    pub instruction: String,
    pub distance_km: f64,
    pub duration_min: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub street_names: Vec<String>,
}

#[derive(Debug)]
pub struct SnipeRouteLimiter {
    max_per_minute: usize,
    requests: Mutex<VecDeque<Instant>>,
}

impl SnipeRouteLimiter {
    pub fn new(max_per_minute: usize) -> Self {
        Self {
            max_per_minute,
            requests: Mutex::new(VecDeque::new()),
        }
    }

    async fn check(&self) -> Result<(), Duration> {
        if self.max_per_minute == 0 {
            return Ok(());
        }

        let now = Instant::now();
        let window = Duration::from_secs(60);
        let mut requests = self.requests.lock().await;
        while requests
            .front()
            .is_some_and(|t| now.duration_since(*t) >= window)
        {
            requests.pop_front();
        }

        if requests.len() >= self.max_per_minute {
            let retry_after = requests
                .front()
                .map(|t| window.saturating_sub(now.duration_since(*t)))
                .unwrap_or_else(|| Duration::from_secs(1));
            Err(retry_after)
        } else {
            requests.push_back(now);
            Ok(())
        }
    }
}

fn is_authorized(headers: &HeaderMap) -> bool {
    crate::auth::is_env_bearer_authorized(headers, "SNIPING_API_KEY")
}

fn unauthorized() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        "Invalid or missing stream sniping token",
    )
        .into_response()
}

pub async fn status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !is_authorized(&headers) {
        return unauthorized();
    }

    let (live, last_location_ts, last_push_age_ms) = {
        let trail = state.trail.lock().await;
        (
            trail.session_active,
            (!trail.points.is_empty()).then_some(trail.last_location_ts),
            trail
                .last_push_at
                .map(|last_push| last_push.elapsed().as_millis() as u64),
        )
    };
    let age_ms =
        last_location_ts.map(|ts| chrono::Utc::now().timestamp_millis().saturating_sub(ts));
    let loc = state.live_location.read().await;
    let streamer = if live && loc.valid {
        Some(SnipeLocation {
            lat: loc.lat,
            lon: loc.lon,
        })
    } else {
        None
    };

    (
        StatusCode::OK,
        Json(SnipeStatusResponse {
            live,
            streamer,
            last_location_ts,
            age_ms,
            last_push_age_ms,
        }),
    )
        .into_response()
}

pub async fn route_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SnipeRouteRequest>,
) -> impl IntoResponse {
    if !is_authorized(&headers) {
        return unauthorized();
    }

    if let Err(retry_after) = state.snipe_route_limiter.check().await {
        let seconds = retry_after.as_secs().max(1).to_string();
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, seconds)],
            "Rate limit exceeded; try again soon",
        )
            .into_response();
    }

    if !req.lat.is_finite() || !req.lon.is_finite() {
        return (StatusCode::BAD_REQUEST, "Invalid origin coordinates").into_response();
    }

    let live = state.trail.lock().await.session_active;
    let loc = state.live_location.read().await;
    if !live || !loc.valid {
        return (StatusCode::CONFLICT, "Streamer is not live").into_response();
    }
    let streamer = SnipeLocation {
        lat: loc.lat,
        lon: loc.lon,
    };
    drop(loc);

    let points = [
        RoutePoint {
            lat: req.lat,
            lon: req.lon,
        },
        RoutePoint {
            lat: streamer.lat,
            lon: streamer.lon,
        },
    ];

    match valhalla::calculate_point_to_point_route(
        &points,
        &state.valhalla_url,
        req.mode.costing(state.walking_speed_kmh),
    )
    .await
    {
        Ok(route) => {
            let maneuvers = route
                .maneuvers
                .into_iter()
                .map(|m| SnipeManeuver {
                    instruction: m.instruction,
                    distance_km: m.distance_km,
                    duration_min: m.duration_min,
                    street_names: m.street_names,
                })
                .collect();
            (
                StatusCode::OK,
                Json(SnipeRouteResponse {
                    streamer,
                    polyline: route.polyline,
                    distance_km: route.distance_km,
                    duration_min: route.duration_min,
                    maneuvers,
                }),
            )
                .into_response()
        }
        Err(e) => {
            tracing::warn!("stream snipe route failed: {e}");
            (StatusCode::BAD_GATEWAY, e).into_response()
        }
    }
}

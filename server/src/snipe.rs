use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::ws::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TravelMode {
    Car,
    Cycling,
    Walking,
}

impl TravelMode {
    fn valhalla_costing(&self) -> &'static str {
        match self {
            TravelMode::Car => "auto",
            TravelMode::Cycling => "bicycle",
            TravelMode::Walking => "pedestrian",
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

#[derive(Debug, serde::Deserialize)]
struct ValhallaResponse {
    trip: ValhallaTrip,
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaTrip {
    summary: ValhallaSummary,
    legs: Vec<ValhallaLeg>,
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaSummary {
    length: f64,
    time: f64,
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaLeg {
    shape: String,
    maneuvers: Vec<ValhallaManeuver>,
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaManeuver {
    instruction: String,
    length: f64,
    time: f64,
    #[serde(default)]
    street_names: Vec<String>,
}

fn is_authorized(headers: &HeaderMap) -> bool {
    let expected = match std::env::var("SNIPING_API_KEY") {
        Ok(token) if !token.is_empty() => token,
        _ => return false,
    };

    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
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

    let live = state.trail.lock().await.session_active;
    let loc = state.live_location.read().await;
    let streamer = if live && loc.valid {
        Some(SnipeLocation {
            lat: loc.lat,
            lon: loc.lon,
        })
    } else {
        None
    };

    (StatusCode::OK, Json(SnipeStatusResponse { live, streamer })).into_response()
}

pub async fn route_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SnipeRouteRequest>,
) -> impl IntoResponse {
    if !is_authorized(&headers) {
        return unauthorized();
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

    match calculate_route(
        &state.valhalla_url,
        req.lat,
        req.lon,
        streamer.lat,
        streamer.lon,
        req.mode,
        state.walking_speed_kmh,
    )
    .await
    {
        Ok(mut route) => {
            route.streamer = streamer;
            (StatusCode::OK, Json(route)).into_response()
        }
        Err(e) => {
            tracing::warn!("stream snipe route failed: {e}");
            (StatusCode::BAD_GATEWAY, e).into_response()
        }
    }
}

async fn calculate_route(
    valhalla_url: &str,
    origin_lat: f64,
    origin_lon: f64,
    dest_lat: f64,
    dest_lon: f64,
    mode: TravelMode,
    walking_speed_kmh: f64,
) -> Result<SnipeRouteResponse, String> {
    let costing = mode.valhalla_costing();
    let mut body = serde_json::json!({
        "locations": [
            { "lat": origin_lat, "lon": origin_lon },
            { "lat": dest_lat, "lon": dest_lon }
        ],
        "costing": costing,
        "directions_options": { "units": "kilometers" }
    });

    if matches!(mode, TravelMode::Walking) {
        body["costing_options"] = serde_json::json!({
            "pedestrian": { "walking_speed": walking_speed_kmh }
        });
    }

    let resp = reqwest::Client::new()
        .post(format!("{}/route", valhalla_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Valhalla request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Valhalla returned {status}: {body}"));
    }

    let valhalla: ValhallaResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Valhalla response: {e}"))?;

    let leg = valhalla
        .trip
        .legs
        .first()
        .ok_or("Valhalla returned no legs")?;
    let maneuvers = leg
        .maneuvers
        .iter()
        .map(|m| SnipeManeuver {
            instruction: m.instruction.clone(),
            distance_km: m.length,
            duration_min: m.time / 60.0,
            street_names: m.street_names.clone(),
        })
        .collect();

    Ok(SnipeRouteResponse {
        streamer: SnipeLocation {
            lat: dest_lat,
            lon: dest_lon,
        },
        polyline: leg.shape.clone(),
        distance_km: valhalla.trip.summary.length,
        duration_min: valhalla.trip.summary.time / 60.0,
        maneuvers,
    })
}

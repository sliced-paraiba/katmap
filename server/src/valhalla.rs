use crate::types::{Maneuver, RouteLeg, Waypoint};

pub enum Costing {
    Pedestrian { walking_speed_kmh: f64 },
    Bicycle,
    Auto,
}

impl Costing {
    fn name(&self) -> &'static str {
        match self {
            Costing::Pedestrian { .. } => "pedestrian",
            Costing::Bicycle => "bicycle",
            Costing::Auto => "auto",
        }
    }
}

pub struct RoutePoint {
    pub lat: f64,
    pub lon: f64,
}

pub struct SimpleManeuver {
    pub instruction: String,
    pub distance_km: f64,
    pub duration_min: f64,
    pub street_names: Vec<String>,
}

pub struct PointRouteResult {
    pub polyline: String,
    pub distance_km: f64,
    pub duration_min: f64,
    pub maneuvers: Vec<SimpleManeuver>,
}

/// Valhalla route response (subset of fields we care about)
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
    length: f64, // km
    time: f64,   // seconds
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaLeg {
    shape: String,
    summary: ValhallaSummary,
    maneuvers: Vec<ValhallaManeuver>,
}

#[derive(Debug, serde::Deserialize)]
struct ValhallaManeuver {
    instruction: String,
    length: f64, // km
    time: f64,   // seconds
    #[serde(rename = "type")]
    maneuver_type: u32,
    #[serde(default)]
    street_names: Vec<String>,
    begin_shape_index: u32,
    end_shape_index: u32,
}

pub async fn calculate_route(
    waypoints: &[Waypoint],
    valhalla_url: &str,
    walking_speed_kmh: f64,
) -> Result<RouteResult, String> {
    if waypoints.len() < 2 {
        return Err("Need at least 2 waypoints to calculate a route".into());
    }

    let locations: Vec<serde_json::Value> = waypoints
        .iter()
        .map(|wp| {
            serde_json::json!({
                "lat": wp.lat,
                "lon": wp.lon,
            })
        })
        .collect();

    let valhalla = fetch_valhalla_route(
        valhalla_url,
        locations,
        Costing::Pedestrian { walking_speed_kmh },
    )
    .await?;

    let polyline = merged_polyline(&valhalla.trip.legs);

    // Map legs to our RouteLeg type
    // Track cumulative shape index offset for multi-leg routes
    let mut shape_offset: u32 = 0;
    let legs: Vec<RouteLeg> = valhalla
        .trip
        .legs
        .iter()
        .enumerate()
        .map(|(i, leg)| {
            let start_id = waypoints[i].id;
            let end_id = waypoints[i + 1].id;
            let offset = shape_offset;
            let maneuvers = leg
                .maneuvers
                .iter()
                .map(|m| Maneuver {
                    instruction: m.instruction.clone(),
                    distance_km: m.length,
                    duration_min: m.time / 60.0,
                    maneuver_type: m.maneuver_type,
                    street_names: m.street_names.clone(),
                    begin_shape_index: m.begin_shape_index + offset,
                    end_shape_index: m.end_shape_index + offset,
                })
                .collect();
            // For the next leg, offset by this leg's last shape index
            // (minus 1 because the junction point is shared)
            if let Some(last_m) = leg.maneuvers.last() {
                shape_offset += last_m.end_shape_index;
            }
            RouteLeg {
                start_waypoint_id: start_id,
                end_waypoint_id: end_id,
                distance_km: leg.summary.length,
                duration_min: leg.summary.time / 60.0,
                maneuvers,
            }
        })
        .collect();

    Ok(RouteResult {
        polyline,
        distance_km: valhalla.trip.summary.length,
        duration_min: valhalla.trip.summary.time / 60.0,
        legs,
    })
}

pub struct RouteResult {
    pub polyline: String,
    pub distance_km: f64,
    pub duration_min: f64,
    pub legs: Vec<RouteLeg>,
}

pub async fn calculate_point_to_point_route(
    points: &[RoutePoint],
    valhalla_url: &str,
    costing: Costing,
) -> Result<PointRouteResult, String> {
    if points.len() < 2 {
        return Err("Need at least 2 points to calculate a route".into());
    }

    let locations: Vec<serde_json::Value> = points
        .iter()
        .map(|point| {
            serde_json::json!({
                "lat": point.lat,
                "lon": point.lon,
            })
        })
        .collect();

    let valhalla = fetch_valhalla_route(valhalla_url, locations, costing).await?;
    let polyline = merged_polyline(&valhalla.trip.legs);
    let maneuvers = valhalla
        .trip
        .legs
        .iter()
        .flat_map(|leg| &leg.maneuvers)
        .map(|m| SimpleManeuver {
            instruction: m.instruction.clone(),
            distance_km: m.length,
            duration_min: m.time / 60.0,
            street_names: m.street_names.clone(),
        })
        .collect();

    Ok(PointRouteResult {
        polyline,
        distance_km: valhalla.trip.summary.length,
        duration_min: valhalla.trip.summary.time / 60.0,
        maneuvers,
    })
}

async fn fetch_valhalla_route(
    valhalla_url: &str,
    locations: Vec<serde_json::Value>,
    costing: Costing,
) -> Result<ValhallaResponse, String> {
    let costing_name = costing.name();
    let mut body = serde_json::json!({
        "locations": locations,
        "costing": costing_name,
        "directions_options": {
            "units": "kilometers"
        }
    });

    if let Costing::Pedestrian { walking_speed_kmh } = costing {
        body["costing_options"] = serde_json::json!({
            "pedestrian": {
                "walking_speed": walking_speed_kmh
            }
        });
    }

    let client = reqwest::Client::new();
    let resp = client
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

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse Valhalla response: {e}"))
}

fn merged_polyline(legs: &[ValhallaLeg]) -> String {
    if legs.len() == 1 {
        return legs[0].shape.clone();
    }

    // Decode all legs, merge (skipping duplicate junction points), re-encode.
    let mut all_coords: Vec<(f64, f64)> = Vec::new();
    for (i, leg) in legs.iter().enumerate() {
        let decoded = decode_polyline6(&leg.shape);
        if i == 0 {
            all_coords.extend(decoded);
        } else {
            all_coords.extend(decoded.into_iter().skip(1));
        }
    }
    encode_polyline6(&all_coords)
}

/// Decode a precision-6 encoded polyline into (lat, lon) pairs
fn decode_polyline6(encoded: &str) -> Vec<(f64, f64)> {
    let mut coords = Vec::new();
    let bytes = encoded.as_bytes();
    let mut index = 0;
    let mut lat = 0i64;
    let mut lng = 0i64;

    while index < bytes.len() {
        // Decode latitude
        let mut shift = 0;
        let mut result = 0i64;
        loop {
            let byte = (bytes[index] as i64) - 63;
            index += 1;
            result |= (byte & 0x1f) << shift;
            shift += 5;
            if byte < 0x20 {
                break;
            }
        }
        lat += if result & 1 != 0 {
            !(result >> 1)
        } else {
            result >> 1
        };

        // Decode longitude
        shift = 0;
        result = 0;
        loop {
            let byte = (bytes[index] as i64) - 63;
            index += 1;
            result |= (byte & 0x1f) << shift;
            shift += 5;
            if byte < 0x20 {
                break;
            }
        }
        lng += if result & 1 != 0 {
            !(result >> 1)
        } else {
            result >> 1
        };

        coords.push((lat as f64 / 1e6, lng as f64 / 1e6));
    }

    coords
}

/// Encode (lat, lon) pairs into a precision-6 encoded polyline
fn encode_polyline6(coords: &[(f64, f64)]) -> String {
    let mut output = String::new();
    let mut prev_lat = 0i64;
    let mut prev_lng = 0i64;

    for &(lat, lng) in coords {
        let lat_i = (lat * 1e6).round() as i64;
        let lng_i = (lng * 1e6).round() as i64;

        encode_value(lat_i - prev_lat, &mut output);
        encode_value(lng_i - prev_lng, &mut output);

        prev_lat = lat_i;
        prev_lng = lng_i;
    }

    output
}

fn encode_value(value: i64, output: &mut String) {
    let mut v = if value < 0 { !(value << 1) } else { value << 1 } as u64;

    while v >= 0x20 {
        output.push(((((v & 0x1f) as u8) | 0x20) + 63) as char);
        v >>= 5;
    }
    output.push(((v as u8) + 63) as char);
}

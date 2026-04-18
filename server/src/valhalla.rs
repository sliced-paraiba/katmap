use crate::types::{Maneuver, RouteLeg, Waypoint};

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

    let body = serde_json::json!({
        "locations": locations,
        "costing": "pedestrian",
        "costing_options": {
            "pedestrian": {
                "walking_speed": walking_speed_kmh
            }
        },
        "directions_options": {
            "units": "kilometers"
        }
    });

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

    let valhalla: ValhallaResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Valhalla response: {e}"))?;

    // Build the full encoded polyline by concatenating leg shapes.
    // Each leg has its own shape — we need to merge them.
    // The last point of leg N == first point of leg N+1 in Valhalla,
    // but encoded polylines are delta-encoded so we can't just concatenate strings.
    // Instead, use the first leg's shape as the full polyline if there's only one leg,
    // or re-encode from decoded coordinates.
    let polyline = if valhalla.trip.legs.len() == 1 {
        valhalla.trip.legs[0].shape.clone()
    } else {
        // Decode all legs, merge (skipping duplicate junction points), re-encode
        let mut all_coords: Vec<(f64, f64)> = Vec::new();
        for (i, leg) in valhalla.trip.legs.iter().enumerate() {
            let decoded = decode_polyline6(&leg.shape);
            if i == 0 {
                all_coords.extend(decoded);
            } else {
                // Skip first point (duplicate of previous leg's last point)
                all_coords.extend(decoded.into_iter().skip(1));
            }
        }
        encode_polyline6(&all_coords)
    };

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
    let mut v = if value < 0 {
        !(value << 1)
    } else {
        value << 1
    } as u64;

    while v >= 0x20 {
        output.push(((((v & 0x1f) as u8) | 0x20) + 63) as char);
        v >>= 5;
    }
    output.push(((v as u8) + 63) as char);
}

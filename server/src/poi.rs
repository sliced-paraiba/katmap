use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::ws::AppState;

const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";
const SEARCH_RADIUS_M: u32 = 30;
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

pub type PoiCache = HashMap<String, PoiCacheEntry>;

#[derive(Debug, Clone)]
pub struct PoiCacheEntry {
    expires_at: Instant,
    response: PoiResponse,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoiQuery {
    lat: f64,
    lon: f64,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PoiResponse {
    pub pois: Vec<PoiResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PoiResult {
    pub name: Option<String>,
    pub category: String,
    pub lat: f64,
    pub lon: f64,
    pub distance_m: f64,
    pub google_maps_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_hours: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuisine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheelchair: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internet_access: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outdoor_seating: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeaway: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toilets: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vegan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vegetarian: Option<String>,
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct OverpassResponse {
    elements: Vec<OverpassElement>,
}

#[derive(Debug, Deserialize)]
struct OverpassElement {
    #[serde(default)]
    lat: Option<f64>,
    #[serde(default)]
    lon: Option<f64>,
    #[serde(default)]
    center: Option<OverpassCenter>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct OverpassCenter {
    lat: f64,
    lon: f64,
}

pub fn new_cache() -> RwLock<PoiCache> {
    RwLock::new(HashMap::new())
}

pub async fn poi_handler(
    State(state): State<AppState>,
    Query(query): Query<PoiQuery>,
) -> impl IntoResponse {
    if !query.lat.is_finite()
        || !query.lon.is_finite()
        || query.lat.abs() > 90.0
        || query.lon.abs() > 180.0
    {
        return (StatusCode::BAD_REQUEST, "Invalid lat/lon").into_response();
    }

    let key = cache_key(&query);
    let now = Instant::now();
    if let Some(entry) = state.poi_cache.read().await.get(&key) {
        if entry.expires_at > now {
            return Json(entry.response.clone()).into_response();
        }
    }

    let response = match fetch_pois(&query).await {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!("POI lookup failed: {err}");
            return (StatusCode::BAD_GATEWAY, err).into_response();
        }
    };

    let mut cache = state.poi_cache.write().await;
    cache.retain(|_, entry| entry.expires_at > now);
    cache.insert(
        key,
        PoiCacheEntry {
            expires_at: now + CACHE_TTL,
            response: response.clone(),
        },
    );

    Json(response).into_response()
}

fn cache_key(query: &PoiQuery) -> String {
    format!(
        "{:.4},{:.4},{}",
        query.lat,
        query.lon,
        query.name.as_deref().unwrap_or("").trim().to_lowercase()
    )
}

async fn fetch_pois(query: &PoiQuery) -> Result<PoiResponse, String> {
    let overpass_query = format!(
        r#"[out:json][timeout:7];(
  nwr(around:{radius},{lat},{lon})[~"^(amenity|shop|tourism|leisure|office|craft|historic|natural|railway|public_transport)$"~"."];
);out center tags 20;"#,
        radius = SEARCH_RADIUS_M,
        lat = query.lat,
        lon = query.lon,
    );

    let client = reqwest::Client::new();
    let res = client
        .post(OVERPASS_URL)
        .header("User-Agent", "katmap-poi/1.0")
        .form(&[("data", overpass_query)])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Overpass returned {}", res.status()));
    }

    let body = res.text().await.map_err(|e| e.to_string())?;
    let parsed: OverpassResponse = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut pois: Vec<PoiResult> = parsed
        .elements
        .into_iter()
        .filter_map(|el| build_poi(query, el))
        .collect();

    let preferred_name = query
        .name
        .as_deref()
        .map(normalize_name)
        .filter(|s| !s.is_empty());
    pois.sort_by(|a, b| {
        let a_name_score = name_score(a.name.as_deref(), preferred_name.as_deref());
        let b_name_score = name_score(b.name.as_deref(), preferred_name.as_deref());
        b_name_score.cmp(&a_name_score).then_with(|| {
            a.distance_m
                .partial_cmp(&b.distance_m)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    pois.truncate(5);

    Ok(PoiResponse { pois })
}

fn build_poi(query: &PoiQuery, el: OverpassElement) -> Option<PoiResult> {
    let lat = el.lat.or(el.center.as_ref().map(|c| c.lat))?;
    let lon = el.lon.or(el.center.as_ref().map(|c| c.lon))?;
    if !is_interesting(&el.tags) {
        return None;
    }

    let name = first_tag(&el.tags, &["name", "brand", "operator"]);
    let category = category_label(&el.tags);
    let distance_m = haversine_m(query.lat, query.lon, lat, lon);
    let address = address(&el.tags);
    let google_maps_url = google_maps_url(name.as_deref(), lat, lon);

    Some(PoiResult {
        name,
        category,
        lat,
        lon,
        distance_m,
        google_maps_url,
        address,
        opening_hours: tag(&el.tags, "opening_hours"),
        phone: first_tag(&el.tags, &["phone", "contact:phone"]),
        website: first_tag(&el.tags, &["website", "contact:website"]),
        cuisine: tag(&el.tags, "cuisine"),
        wheelchair: tag(&el.tags, "wheelchair"),
        internet_access: tag(&el.tags, "internet_access"),
        outdoor_seating: tag(&el.tags, "outdoor_seating"),
        delivery: tag(&el.tags, "delivery"),
        takeaway: tag(&el.tags, "takeaway"),
        toilets: tag(&el.tags, "toilets"),
        vegan: tag(&el.tags, "diet:vegan"),
        vegetarian: tag(&el.tags, "diet:vegetarian"),
        tags: el.tags,
    })
}

fn is_interesting(tags: &BTreeMap<String, String>) -> bool {
    [
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "office",
        "craft",
        "historic",
        "natural",
        "railway",
        "public_transport",
    ]
    .iter()
    .any(|key| tags.contains_key(*key))
}

fn category_label(tags: &BTreeMap<String, String>) -> String {
    for key in [
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "office",
        "craft",
        "historic",
        "natural",
        "railway",
        "public_transport",
    ] {
        if let Some(value) = tags.get(key) {
            return prettify(value);
        }
    }
    "Point of interest".to_string()
}

fn prettify(value: &str) -> String {
    let mut out = String::new();
    for (idx, part) in value.split('_').enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

fn tag(tags: &BTreeMap<String, String>, key: &str) -> Option<String> {
    tags.get(key).filter(|s| !s.is_empty()).cloned()
}

fn first_tag(tags: &BTreeMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| tag(tags, key))
}

fn address(tags: &BTreeMap<String, String>) -> Option<String> {
    let house = tag(tags, "addr:housenumber");
    let street = tag(tags, "addr:street");
    let city = tag(tags, "addr:city");
    let mut parts = Vec::new();
    match (house, street) {
        (Some(house), Some(street)) => parts.push(format!("{house} {street}")),
        (None, Some(street)) => parts.push(street),
        (Some(house), None) => parts.push(house),
        (None, None) => {}
    }
    if let Some(city) = city {
        parts.push(city);
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn google_maps_url(name: Option<&str>, lat: f64, lon: f64) -> String {
    match name.filter(|s| !s.trim().is_empty()) {
        Some(name) => format!(
            "https://www.google.com/maps/search/?api=1&query={}&query_place_id=&center={},{}",
            url_encode(name),
            lat,
            lon,
        ),
        None => format!("https://maps.google.com/?q={lat},{lon}"),
    }
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
            b' ' => vec!['+'],
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

fn normalize_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn name_score(name: Option<&str>, preferred: Option<&str>) -> i32 {
    let Some(preferred) = preferred else {
        return 0;
    };
    let Some(name) = name else {
        return 0;
    };
    let normalized = normalize_name(name);
    if normalized == preferred {
        2
    } else if normalized.contains(preferred) || preferred.contains(&normalized) {
        1
    } else {
        0
    }
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

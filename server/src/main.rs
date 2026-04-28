mod companion;
#[cfg(test)]
mod domain_tests;
mod history;
mod resolve;
mod snipe;
mod types;
mod valhalla;
mod ws;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use axum::Router;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post};
use tokio::sync::{Mutex, RwLock, broadcast};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use ws::{AppState, SocialLinks, ws_handler};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "debug".into()),
        )
        .init();

    let (tx, _) = broadcast::channel::<types::ServerMessage>(256);

    let valhalla_url =
        std::env::var("VALHALLA_URL").unwrap_or_else(|_| "http://127.0.0.1:8002".to_string());
    tracing::info!("Valhalla URL: {valhalla_url}");

    let walking_speed_kmh: f64 = std::env::var("WALKING_SPEED_KMH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5.1);
    tracing::info!("Walking speed: {walking_speed_kmh} km/h");

    let companion_api_key =
        std::env::var("COMPANION_API_KEY").expect("COMPANION_API_KEY is required");
    tracing::info!("Companion API key configured");

    let display_name = std::env::var("DISPLAY_NAME").unwrap_or_else(|_| "streamer".to_string());
    tracing::info!("Display name: {display_name}");

    let avatar_path =
        std::env::var("AVATAR_PATH").unwrap_or_else(|_| "/opt/katmap/avatar.png".to_string());
    tracing::info!("Avatar path: {avatar_path}");

    // Social links — only non-empty values are included
    let social_links = SocialLinks {
        discord: std::env::var("SOCIAL_DISCORD")
            .ok()
            .filter(|s| !s.is_empty()),
        kick: std::env::var("SOCIAL_KICK").ok().filter(|s| !s.is_empty()),
        twitch: std::env::var("SOCIAL_TWITCH")
            .ok()
            .filter(|s| !s.is_empty()),
    };
    tracing::info!(
        "Social links: discord={} kick={} twitch={}",
        social_links.discord.is_some(),
        social_links.kick.is_some(),
        social_links.twitch.is_some()
    );

    let history_state: &'static history::HistoryState =
        Box::leak(Box::new(history::init_history(history::db_path()).await));

    let state = AppState {
        waypoints: Arc::new(RwLock::new(Vec::new())),
        undo_stack: Arc::new(RwLock::new(Vec::new())),
        tx: tx.clone(),
        connected_count: Arc::new(AtomicUsize::new(0)),
        valhalla_url,
        walking_speed_kmh,
        companion_api_key,
        display_name,
        avatar_path: avatar_path.clone(),
        history: Some(history_state),
        social_links,
        trail: Arc::new(Mutex::new(companion::TrailAccumulator::default())),
        live_location: Arc::new(RwLock::new(ws::LiveLocation::default())),
    };

    // Spawn stale session detector
    {
        let state_clone = state.clone();
        tokio::spawn(async move {
            companion::stale_detector(state_clone).await;
        });
        tracing::info!("Companion stale detector spawned");
    }

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/config", get(config_handler))
        .route("/api/avatar", get(avatar_handler))
        .route("/api/location", post(companion::location_handler))
        .route("/api/location/status", get(companion::status_handler))
        .route("/api/history", get(history::list_history_handler))
        .route(
            "/admin/history",
            get(|| async { Redirect::temporary("/admin-history.html") }),
        )
        .route(
            "/api/admin/history",
            get(history::admin_list_history_handler),
        )
        .route(
            "/api/admin/history/{id}",
            axum::routing::patch(history::admin_update_history_handler)
                .delete(history::admin_delete_history_handler),
        )
        .route(
            "/api/admin/history/{id}/edits",
            axum::routing::put(history::admin_update_edits_handler),
        )
        .route(
            "/snipe",
            get(|| async { Redirect::temporary("/snipe.html") }),
        )
        .route("/api/snipe/status", get(snipe::status_handler))
        .route("/api/snipe/route", post(snipe::route_handler))
        .route("/resolve-url", get(resolve::resolve_url))
        .route(
            "/discord",
            get({
                let discord_url = state.social_links.discord.clone();
                move || async move {
                    match discord_url {
                        Some(url) => Redirect::permanent(&url).into_response(),
                        None => (StatusCode::NOT_FOUND, "Discord not configured").into_response(),
                    }
                }
            }),
        )
        .fallback_service(ServeDir::new("../client/dist"))
        .with_state(state.clone())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers([AUTHORIZATION, axum::http::header::CONTENT_TYPE]),
        );

    let addr = "127.0.0.1:3001";
    tracing::info!("Listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    // Graceful shutdown: save any active trail
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("Shutdown signal received, saving active trail...");
        companion::save_on_shutdown(&state).await;
        std::process::exit(0);
    });

    axum::serve(listener, app).await.unwrap();
}

async fn config_handler(AxumState(state): AxumState<AppState>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "display_name": state.display_name,
        "social": {
            "discord": state.social_links.discord,
            "kick": state.social_links.kick,
            "twitch": state.social_links.twitch,
        },
    }))
}

async fn avatar_handler(AxumState(state): AxumState<AppState>) -> impl IntoResponse {
    match tokio::fs::read(&state.avatar_path).await {
        Ok(bytes) => {
            let content_type = infer_content_type(&state.avatar_path, &bytes);
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, content_type)],
                axum::body::Body::from(bytes),
            )
                .into_response()
        }
        Err(e) => {
            tracing::warn!("Failed to read avatar {}: {e}", state.avatar_path);
            (StatusCode::NOT_FOUND, "Avatar not found").into_response()
        }
    }
}

fn infer_content_type(path: &str, bytes: &[u8]) -> String {
    // Try by extension first, fall back to magic bytes
    match path.rsplit('.').next() {
        Some("png") => "image/png".to_string(),
        Some("jpg") | Some("jpeg") => "image/jpeg".to_string(),
        Some("gif") => "image/gif".to_string(),
        Some("webp") => "image/webp".to_string(),
        Some("svg") => "image/svg+xml".to_string(),
        _ => {
            // Magic byte fallback
            if bytes.starts_with(b"\x89PNG") {
                "image/png".to_string()
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "image/jpeg".to_string()
            } else if bytes.starts_with(b"GIF8") {
                "image/gif".to_string()
            } else if bytes.starts_with(b"RIFF") && bytes.len() > 11 && &bytes[8..12] == b"WEBP" {
                "image/webp".to_string()
            } else {
                "application/octet-stream".to_string()
            }
        }
    }
}

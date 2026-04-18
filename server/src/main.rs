mod companion;
mod history;
mod resolve;
mod twitch;
mod types;
mod valhalla;
mod ws;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect};
use axum::Router;
use axum::routing::{get, post};
use tokio::sync::{Mutex, RwLock, broadcast};
use tower_http::services::ServeDir;
use tower_http::cors::{CorsLayer, Any};
use axum::http::header::AUTHORIZATION;

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

    let valhalla_url = std::env::var("VALHALLA_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8002".to_string());
    tracing::info!("Valhalla URL: {valhalla_url}");

    let walking_speed_kmh: f64 = std::env::var("WALKING_SPEED_KMH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5.1);
    tracing::info!("Walking speed: {walking_speed_kmh} km/h");

    let companion_api_key = std::env::var("COMPANION_API_KEY")
        .expect("COMPANION_API_KEY is required");
    tracing::info!("Companion API key configured");

    let display_name = std::env::var("DISPLAY_NAME")
        .unwrap_or_else(|_| "streamer".to_string());
    tracing::info!("Display name: {display_name}");

    let twitch = match (
        std::env::var("TWITCH_CLIENT_ID"),
        std::env::var("TWITCH_CLIENT_SECRET"),
    ) {
        (Ok(id), Ok(secret)) if !id.is_empty() && !secret.is_empty() => {
            tracing::info!("Twitch avatar proxy enabled (client_id={}...)", &id[..8.min(id.len())]);
            Some(twitch::TwitchState::new(id, secret))
        }
        _ => {
            tracing::warn!("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set — avatar proxy disabled");
            None
        }
    };

    // Social links — only non-empty values are included
    let social_links = SocialLinks {
        discord: std::env::var("SOCIAL_DISCORD").ok().filter(|s| !s.is_empty()),
        kick: std::env::var("SOCIAL_KICK").ok().filter(|s| !s.is_empty()),
        twitch: std::env::var("SOCIAL_TWITCH").ok().filter(|s| !s.is_empty()),
    };
    tracing::info!("Social links: discord={} kick={} twitch={}",
        social_links.discord.is_some(),
        social_links.kick.is_some(),
        social_links.twitch.is_some()
    );

    let history_state: &'static history::HistoryState = Box::leak(Box::new(
        history::init_history(history::db_path()).await,
    ));

    let state = AppState {
        waypoints: Arc::new(RwLock::new(Vec::new())),
        undo_stack: Arc::new(RwLock::new(Vec::new())),
        tx: tx.clone(),
        connected_count: Arc::new(AtomicUsize::new(0)),
        valhalla_url,
        walking_speed_kmh,
        companion_api_key,
        display_name,
        twitch,
        history: Some(history_state),
        social_links,
        trail: Arc::new(Mutex::new(companion::TrailAccumulator::default())),
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
        .route("/api/config", get(twitch::config_handler))
        .route("/api/twitch/avatar/{login}", get(twitch::avatar_handler))
        .route("/api/location", post(companion::location_handler))
        .route("/api/location/status", get(companion::status_handler))
        .route("/api/history", get(history::list_history_handler))
        .route("/resolve-url", get(resolve::resolve_url))
        .route("/discord", get({
            let discord_url = state.social_links.discord.clone();
            move || async move {
                match discord_url {
                    Some(url) => Redirect::permanent(&url).into_response(),
                    None => (StatusCode::NOT_FOUND, "Discord not configured").into_response(),
                }
            }
        }))
        .fallback_service(ServeDir::new("../client/dist"))
        .with_state(state.clone())
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers([AUTHORIZATION, axum::http::header::CONTENT_TYPE]));

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

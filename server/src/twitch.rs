use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Redirect},
};
use tokio::sync::Mutex;

use crate::ws::AppState;

const AVATAR_CACHE_TTL: Duration = Duration::from_secs(3600);
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);

struct TwitchInner {
    token: Option<String>,
    token_expires_at: Instant,
    avatar_cache: HashMap<String, (String, Instant)>,
}

#[derive(Clone)]
pub struct TwitchState {
    client_id: String,
    client_secret: String,
    inner: Arc<Mutex<TwitchInner>>,
    http: reqwest::Client,
}

impl TwitchState {
    pub fn new(client_id: String, client_secret: String) -> Self {
        TwitchState {
            client_id,
            client_secret,
            inner: Arc::new(Mutex::new(TwitchInner {
                token: None,
                token_expires_at: Instant::now(),
                avatar_cache: HashMap::new(),
            })),
            http: reqwest::Client::new(),
        }
    }

    async fn get_access_token(&self) -> Option<String> {
        let mut inner = self.inner.lock().await;

        let still_valid = inner.token.is_some()
            && inner.token_expires_at.saturating_duration_since(Instant::now())
                > TOKEN_REFRESH_MARGIN;

        if still_valid {
            return inner.token.clone();
        }

        tracing::info!("twitch: fetching new app access token");
        let resp = self
            .http
            .post("https://id.twitch.tv/oauth2/token")
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await
            .ok()?;

        if !resp.status().is_success() {
            tracing::warn!("twitch: token request returned {}", resp.status());
            return None;
        }

        let body: serde_json::Value = resp.json().await.ok()?;
        let token = body["access_token"].as_str()?.to_string();
        let expires_in = body["expires_in"].as_u64().unwrap_or(3600);

        inner.token = Some(token.clone());
        inner.token_expires_at = Instant::now() + Duration::from_secs(expires_in);

        tracing::info!("twitch: access token valid for {}s", expires_in);
        Some(token)
    }

    pub async fn get_avatar_url(&self, login: &str) -> Option<String> {
        {
            let inner = self.inner.lock().await;
            if let Some((url, fetched_at)) = inner.avatar_cache.get(login) {
                if fetched_at.elapsed() < AVATAR_CACHE_TTL {
                    return Some(url.clone());
                }
            }
        }

        let token = self.get_access_token().await?;

        let resp = self
            .http
            .get("https://api.twitch.tv/helix/users")
            .query(&[("login", login)])
            .header("Client-ID", &self.client_id)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .ok()?;

        if !resp.status().is_success() {
            tracing::warn!("twitch: /helix/users returned {} for {login}", resp.status());
            return None;
        }

        let body: serde_json::Value = resp.json().await.ok()?;
        let url = body["data"].get(0)?["profile_image_url"].as_str()?.to_string();

        {
            let mut inner = self.inner.lock().await;
            inner
                .avatar_cache
                .insert(login.to_string(), (url.clone(), Instant::now()));
        }

        tracing::debug!("twitch: resolved avatar for {login}");
        Some(url)
    }
}

pub async fn config_handler(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "display_name": state.display_name,
        "social": {
            "discord": state.social_links.discord,
            "kick": state.social_links.kick,
            "twitch": state.social_links.twitch,
        },
    }))
}

pub async fn avatar_handler(
    Path(login): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let twitch: &TwitchState = match &state.twitch {
        Some(t) => t,
        None => {
            return (StatusCode::NOT_FOUND, "Twitch not configured").into_response();
        }
    };

    let login_str: String = login.to_lowercase();
    let url_opt: Option<String> = twitch.get_avatar_url(&login_str).await;
    match url_opt {
        Some(url) => Redirect::temporary(&url).into_response(),
        None => (StatusCode::NOT_FOUND, "Avatar not found").into_response(),
    }
}

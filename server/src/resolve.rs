use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ResolveParams {
    pub url: String,
}

/// Allowed hostnames for URL resolution — prevents abuse as an open redirect resolver.
const ALLOWED_HOSTS: &[&str] = &[
    "maps.app.goo.gl",
    "goo.gl",
    "www.google.com",
    "google.com",
    "maps.google.com",
];

fn is_allowed(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    ALLOWED_HOSTS.contains(&host)
}

pub async fn resolve_url(Query(params): Query<ResolveParams>) -> impl IntoResponse {
    if !is_allowed(&params.url) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({
                "error": "URL is not from an allowed Google Maps domain"
            })),
        );
    }

    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (compatible; katmap/1.0)")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to build HTTP client: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "Internal error" })),
            );
        }
    };

    match client.get(&params.url).send().await {
        Ok(resp) => {
            let final_url = resp.url().to_string();
            tracing::debug!("Resolved {} -> {}", params.url, final_url);
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "url": final_url })),
            )
        }
        Err(e) => {
            tracing::warn!("Failed to resolve URL {}: {e}", params.url);
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(serde_json::json!({ "error": format!("Failed to resolve URL: {e}") })),
            )
        }
    }
}

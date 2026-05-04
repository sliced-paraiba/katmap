use axum::http::HeaderMap;

pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

pub fn is_bearer_authorized(headers: &HeaderMap, expected: &str) -> bool {
    !expected.is_empty() && bearer_token(headers).is_some_and(|token| token == expected)
}

pub fn is_companion_authorized(headers: &HeaderMap, companion_api_key: &str) -> bool {
    is_bearer_authorized(headers, companion_api_key)
}

pub fn is_admin_authorized(headers: &HeaderMap, companion_api_key: &str) -> bool {
    let expected = std::env::var("ADMIN_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| companion_api_key.to_string());
    is_bearer_authorized(headers, &expected)
}

pub fn is_env_bearer_authorized(headers: &HeaderMap, env_var: &str) -> bool {
    let expected = match std::env::var(env_var) {
        Ok(token) if !token.is_empty() => token,
        _ => return false,
    };
    is_bearer_authorized(headers, &expected)
}

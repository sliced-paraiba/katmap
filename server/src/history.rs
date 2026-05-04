use std::path::PathBuf;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use rusqlite::{Connection, Statement, params};
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task;

use crate::ws::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub streamer_id: String,
    pub platform: String,
    pub started_at: i64,
    pub ended_at: i64,
    #[serde(default)]
    pub stream_title: Option<String>,
    #[serde(default)]
    pub viewer_count: Option<i32>,
    pub breadcrumbs: Vec<[f64; 2]>,
    /// Full telemetry per point (altitude, accuracy, heading, speed, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<Vec<crate::types::BreadcrumbPoint>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrailEdits {
    /// Original breadcrumb indices hidden from display. Non-destructive: original points stay in DB.
    #[serde(default)]
    pub hidden_indices: Vec<usize>,
    /// Original breadcrumb index -> replacement `[lon, lat]`.
    #[serde(default)]
    pub moved_points: BTreeMap<usize, [f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminHistoryEntry {
    pub id: i64,
    pub streamer_id: String,
    pub platform: String,
    pub started_at: i64,
    pub ended_at: i64,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub stream_title: Option<String>,
    #[serde(default)]
    pub viewer_count: Option<i32>,
    pub hidden: bool,
    pub completed: bool,
    /// Original, unedited trail.
    pub breadcrumbs: Vec<[f64; 2]>,
    /// Trail after applying `edits`.
    pub edited_breadcrumbs: Vec<[f64; 2]>,
    #[serde(default)]
    pub edits: TrailEdits,
    #[serde(default)]
    pub telemetry: Option<Vec<crate::types::BreadcrumbPoint>>,
}

#[derive(Debug, Clone)]
pub struct IncompleteTrail {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub session_id: Option<String>,
    pub breadcrumbs: Vec<[f64; 2]>,
    pub telemetry: Option<Vec<crate::types::BreadcrumbPoint>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdminUpdateEntry {
    #[serde(default)]
    pub session_id: Option<Option<String>>,
    #[serde(default)]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdminListQuery {
    #[serde(default)]
    pub all: bool,
}

pub struct HistoryState {
    pub db: Mutex<Connection>,
}

pub fn db_path() -> PathBuf {
    std::env::var("HISTORY_DB_PATH")
        .unwrap_or_else(|_| "/opt/katmap/history.db".to_string())
        .into()
}

pub async fn init_history(db_path: PathBuf) -> HistoryState {
    let conn = task::spawn_blocking(move || {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&db_path).expect("failed to open history DB");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL,
                stream_title TEXT,
                viewer_count INTEGER,
                breadcrumbs TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                session_id TEXT
            )",
            [],
        )
        .expect("failed to create history table");

        let has_completed: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('streams') WHERE name = 'completed'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_completed {
            conn.execute(
                "ALTER TABLE streams ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .expect("failed to add completed column");
        }

        let has_session_id: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('streams') WHERE name = 'session_id'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_session_id {
            conn.execute("ALTER TABLE streams ADD COLUMN session_id TEXT", [])
                .expect("failed to add session_id column");
        }

        let has_hidden: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('streams') WHERE name = 'hidden'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_hidden {
            conn.execute(
                "ALTER TABLE streams ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .expect("failed to add hidden column");
        }

        let has_telemetry: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('streams') WHERE name = 'telemetry'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_telemetry {
            conn.execute("ALTER TABLE streams ADD COLUMN telemetry TEXT", [])
                .expect("failed to add telemetry column");
        }

        let has_trail_edits: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('streams') WHERE name = 'trail_edits'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_trail_edits {
            conn.execute("ALTER TABLE streams ADD COLUMN trail_edits TEXT", [])
                .expect("failed to add trail_edits column");
        }
        tracing::info!("History DB initialized at {:?}", db_path);
        conn
    })
    .await
    .expect("task panicked");

    HistoryState {
        db: Mutex::new(conn),
    }
}

pub async fn save_stream_internal(
    state: &HistoryState,
    streamer_id: &str,
    platform: &str,
    started_at: i64,
    ended_at: i64,
    breadcrumbs: &[[f64; 2]],
    telemetry: Option<&str>,
) -> Result<(), String> {
    let breadcrumbs_json = serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;

    {
        let guard = state.db.lock().await;
        guard.execute(
            "INSERT INTO streams (streamer_id, platform, started_at, ended_at, breadcrumbs, telemetry, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![streamer_id, platform, started_at, ended_at, breadcrumbs_json, telemetry],
        ).map_err(|e| {
            tracing::error!("Failed to save stream: {}", e);
            e.to_string()
        })?;
    }
    Ok(())
}

pub async fn upsert_incomplete_trail(
    state: &HistoryState,
    streamer_id: &str,
    platform: &str,
    started_at: i64,
    session_id: &str,
    breadcrumbs: &[[f64; 2]],
    telemetry: Option<&str>,
) -> Result<i64, String> {
    let breadcrumbs_json = serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;

    let guard = state.db.lock().await;

    let existing_id: Option<i64> = guard
        .query_row(
            "SELECT id FROM streams WHERE streamer_id = ?1 AND platform = ?2 AND completed = 0 LIMIT 1",
            params![streamer_id, platform],
            |row| row.get(0),
        )
        .ok();

    if let Some(id) = existing_id {
        guard
            .execute(
                "UPDATE streams SET started_at = ?1, ended_at = ?2, breadcrumbs = ?3, session_id = ?4, telemetry = ?5 WHERE id = ?6",
                params![
                    started_at,
                    chrono::Utc::now().timestamp_millis(),
                    breadcrumbs_json,
                    session_id,
                    telemetry,
                    id
                ],
            )
            .map_err(|e| {
                tracing::error!("Failed to update incomplete trail: {}", e);
                e.to_string()
            })?;
        Ok(id)
    } else {
        let now = chrono::Utc::now().timestamp_millis();
        guard
            .execute(
                "INSERT INTO streams (streamer_id, platform, started_at, ended_at, breadcrumbs, completed, session_id, telemetry)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
                params![streamer_id, platform, started_at, now, breadcrumbs_json, session_id, telemetry],
            )
            .map_err(|e| {
                tracing::error!("Failed to insert incomplete trail: {}", e);
                e.to_string()
            })?;
        let id = guard.last_insert_rowid();
        Ok(id)
    }
}

pub async fn load_latest_incomplete_trail(
    state: &HistoryState,
    streamer_id: &str,
    platform: &str,
) -> Result<Option<IncompleteTrail>, String> {
    let guard = state.db.lock().await;

    let mut stmt = guard
        .prepare(
            "SELECT id, started_at, ended_at, session_id, breadcrumbs, telemetry
             FROM streams
             WHERE streamer_id = ?1 AND platform = ?2 AND completed = 0
             ORDER BY ended_at DESC
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_row(params![streamer_id, platform], |row| {
        let breadcrumbs_json: String = row.get(4)?;
        let telemetry_json: Option<String> = row.get(5)?;
        let breadcrumbs: Vec<[f64; 2]> =
            serde_json::from_str(&breadcrumbs_json).unwrap_or_default();
        let telemetry = telemetry_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<crate::types::BreadcrumbPoint>>(json).ok());

        Ok(IncompleteTrail {
            id: row.get(0)?,
            started_at: row.get(1)?,
            ended_at: row.get(2)?,
            session_id: row.get(3)?,
            breadcrumbs,
            telemetry,
        })
    });

    match result {
        Ok(trail) => Ok(Some(trail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn mark_trail_complete(
    state: &HistoryState,
    trail_id: i64,
    ended_at: i64,
    breadcrumbs: &[[f64; 2]],
    telemetry: Option<&str>,
) -> Result<(), String> {
    let breadcrumbs_json = serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;
    let guard = state.db.lock().await;
    guard
        .execute(
            "UPDATE streams SET completed = 1, ended_at = ?1, breadcrumbs = ?2, telemetry = ?3 WHERE id = ?4",
            params![ended_at, breadcrumbs_json, telemetry, trail_id],
        )
        .map_err(|e| {
            tracing::error!("Failed to mark trail complete: {}", e);
            e.to_string()
        })?;
    Ok(())
}

pub async fn list_history_internal(state: &HistoryState) -> Vec<HistoryEntry> {
    let guard = state.db.lock().await;
    let mut stmt: Statement<'_> = guard
        .prepare(
            "SELECT id, streamer_id, platform, started_at, ended_at, stream_title, viewer_count, breadcrumbs, telemetry, trail_edits
             FROM streams WHERE hidden = 0 ORDER BY started_at DESC",
        )
        .expect("failed to prepare statement");

    let rows = stmt
        .query_map([], |row| {
            let breadcrumbs_json: String = row.get(7)?;
            let breadcrumbs: Vec<[f64; 2]> =
                serde_json::from_str(&breadcrumbs_json).unwrap_or_default();
            let telemetry_json: Option<String> = row.get(8)?;
            let telemetry: Option<Vec<crate::types::BreadcrumbPoint>> =
                telemetry_json.and_then(|j| serde_json::from_str(&j).ok());
            let edits_json: Option<String> = row.get(9)?;
            let edits = parse_edits(edits_json.as_deref());
            Ok(HistoryEntry {
                id: row.get(0)?,
                streamer_id: row.get(1)?,
                platform: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                stream_title: row.get(5)?,
                viewer_count: row.get(6)?,
                breadcrumbs: apply_trail_edits(&breadcrumbs, &edits),
                telemetry,
            })
        })
        .expect("failed to query");

    rows.filter_map(|r| r.ok()).collect()
}

fn parse_edits(json: Option<&str>) -> TrailEdits {
    json.and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default()
}

pub(crate) fn apply_trail_edits(points: &[[f64; 2]], edits: &TrailEdits) -> Vec<[f64; 2]> {
    points
        .iter()
        .enumerate()
        .filter_map(|(idx, point)| {
            if edits.hidden_indices.contains(&idx) {
                None
            } else {
                Some(edits.moved_points.get(&idx).copied().unwrap_or(*point))
            }
        })
        .collect()
}

fn is_admin_authorized(headers: &HeaderMap, state: &AppState) -> bool {
    let expected = std::env::var("ADMIN_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.companion_api_key.clone());
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
}

fn unauthorized() -> axum::response::Response {
    (StatusCode::UNAUTHORIZED, "Invalid or missing admin token").into_response()
}

pub async fn admin_list_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AdminListQuery>,
) -> impl IntoResponse {
    if !is_admin_authorized(&headers, &state) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    let where_clause = if query.all { "" } else { "WHERE hidden = 0" };
    let sql = format!(
        "SELECT id, streamer_id, platform, started_at, ended_at, session_id, stream_title, viewer_count, hidden, completed, breadcrumbs, trail_edits, telemetry FROM streams {where_clause} ORDER BY started_at DESC"
    );
    let mut stmt = match guard.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let rows = match stmt.query_map([], |row| {
        let breadcrumbs_json: String = row.get(10)?;
        let breadcrumbs: Vec<[f64; 2]> =
            serde_json::from_str(&breadcrumbs_json).unwrap_or_default();
        let edits_json: Option<String> = row.get(11)?;
        let edits = parse_edits(edits_json.as_deref());
        let telemetry_json: Option<String> = row.get(12)?;
        let telemetry: Option<Vec<crate::types::BreadcrumbPoint>> =
            telemetry_json.and_then(|j| serde_json::from_str(&j).ok());
        let edited_breadcrumbs = apply_trail_edits(&breadcrumbs, &edits);
        Ok(AdminHistoryEntry {
            id: row.get(0)?,
            streamer_id: row.get(1)?,
            platform: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            session_id: row.get(5)?,
            stream_title: row.get(6)?,
            viewer_count: row.get(7)?,
            hidden: row.get::<_, i32>(8)? != 0,
            completed: row.get::<_, i32>(9)? != 0,
            breadcrumbs,
            edited_breadcrumbs,
            edits,
            telemetry,
        })
    }) {
        Ok(rows) => rows,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let entries: Vec<_> = rows.filter_map(|r| r.ok()).collect();
    (StatusCode::OK, Json(entries)).into_response()
}

pub async fn admin_update_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(update): Json<AdminUpdateEntry>,
) -> impl IntoResponse {
    if !is_admin_authorized(&headers, &state) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    if let Some(session_id) = update.session_id {
        if let Err(e) = guard.execute(
            "UPDATE streams SET session_id = ?1 WHERE id = ?2",
            params![session_id, id],
        ) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    if let Some(hidden) = update.hidden {
        if let Err(e) = guard.execute(
            "UPDATE streams SET hidden = ?1 WHERE id = ?2",
            params![hidden as i32, id],
        ) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    (StatusCode::OK, "Updated").into_response()
}

pub async fn admin_update_edits_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(mut edits): Json<TrailEdits>,
) -> impl IntoResponse {
    if !is_admin_authorized(&headers, &state) {
        return unauthorized();
    }
    edits.hidden_indices.sort_unstable();
    edits.hidden_indices.dedup();
    let json = match serde_json::to_string(&edits) {
        Ok(json) => json,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    match guard.execute(
        "UPDATE streams SET trail_edits = ?1 WHERE id = ?2",
        params![json, id],
    ) {
        Ok(0) => (StatusCode::NOT_FOUND, "Session not found").into_response(),
        Ok(_) => (StatusCode::OK, "Updated").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn admin_delete_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    if !is_admin_authorized(&headers, &state) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    match guard.execute("DELETE FROM streams WHERE id = ?1", [id]) {
        Ok(0) => (StatusCode::NOT_FOUND, "Session not found").into_response(),
        Ok(_) => (StatusCode::OK, "Deleted").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn list_history_handler(State(state): State<AppState>) -> impl IntoResponse {
    let history = match &state.history {
        Some(h) => h,
        None => {
            return (StatusCode::NOT_FOUND, "History not configured").into_response();
        }
    };

    let entries = list_history_internal(history).await;
    (StatusCode::OK, Json(entries)).into_response()
}

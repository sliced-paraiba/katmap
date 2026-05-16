use std::path::PathBuf;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use rusqlite::{Connection, Row, params};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task;

use crate::ws::AppState;

mod db;
mod edits;
use db::run_column_migration;
pub use edits::TrailEdits;
pub(crate) use edits::apply_trail_edits;
use edits::parse_edits;

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

#[derive(Debug, Clone)]
pub struct StoredSession {
    pub id: i64,
    pub streamer_id: String,
    pub platform: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub session_id: Option<String>,
    pub hidden: bool,
    pub completed: bool,
    pub stream_title: Option<String>,
    pub viewer_count: Option<i32>,
    pub breadcrumbs_json: String,
    pub telemetry_json: Option<String>,
    pub trail_edits_json: Option<String>,
}

impl StoredSession {
    pub fn breadcrumbs(&self) -> Vec<[f64; 2]> {
        serde_json::from_str(&self.breadcrumbs_json).unwrap_or_default()
    }

    pub fn telemetry(&self) -> Option<Vec<crate::types::BreadcrumbPoint>> {
        self.telemetry_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
    }

    pub fn edits(&self) -> TrailEdits {
        parse_edits(self.trail_edits_json.as_deref())
    }

    pub fn display_name(&self) -> &str {
        self.session_id.as_deref().unwrap_or(&self.streamer_id)
    }

    pub fn point_count(&self) -> usize {
        self.breadcrumbs().len()
    }

    pub fn to_history_entry(&self) -> HistoryEntry {
        let breadcrumbs = self.breadcrumbs();
        let edits = self.edits();
        HistoryEntry {
            id: self.id,
            streamer_id: self.streamer_id.clone(),
            platform: self.platform.clone(),
            started_at: self.started_at,
            ended_at: self.ended_at,
            stream_title: self.stream_title.clone(),
            viewer_count: self.viewer_count,
            breadcrumbs: apply_trail_edits(&breadcrumbs, &edits),
            telemetry: self.telemetry(),
        }
    }

    pub fn to_admin_history_entry(&self) -> AdminHistoryEntry {
        let breadcrumbs = self.breadcrumbs();
        let edits = self.edits();
        let edited_breadcrumbs = apply_trail_edits(&breadcrumbs, &edits);
        AdminHistoryEntry {
            id: self.id,
            streamer_id: self.streamer_id.clone(),
            platform: self.platform.clone(),
            started_at: self.started_at,
            ended_at: self.ended_at,
            session_id: self.session_id.clone(),
            stream_title: self.stream_title.clone(),
            viewer_count: self.viewer_count,
            hidden: self.hidden,
            completed: self.completed,
            breadcrumbs,
            edited_breadcrumbs,
            edits,
            telemetry: self.telemetry(),
        }
    }
}

pub struct HistoryRepo<'a> {
    conn: &'a Connection,
}

impl<'a> HistoryRepo<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn list_sessions(&self, include_hidden: bool) -> rusqlite::Result<Vec<StoredSession>> {
        let where_clause = if include_hidden {
            ""
        } else {
            "WHERE hidden = 0"
        };
        let sql = format!(
            "SELECT {STORED_SESSION_COLUMNS} FROM streams {where_clause} ORDER BY started_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], stored_session_from_row)?;
        rows.collect()
    }

    pub fn get_session(&self, id: i64) -> rusqlite::Result<Option<StoredSession>> {
        let sql = format!("SELECT {STORED_SESSION_COLUMNS} FROM streams WHERE id = ?1");
        let mut stmt = self.conn.prepare(&sql)?;
        match stmt.query_row([id], stored_session_from_row) {
            Ok(session) => Ok(Some(session)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn update_session_id(&self, id: i64, session_id: Option<&str>) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE streams SET session_id = ?1 WHERE id = ?2",
            params![session_id, id],
        )
    }

    pub fn set_hidden(&self, id: i64, hidden: bool) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE streams SET hidden = ?1 WHERE id = ?2",
            params![hidden as i32, id],
        )
    }

    pub fn delete_session(&self, id: i64) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM streams WHERE id = ?1", [id])
    }
}

const STORED_SESSION_COLUMNS: &str = "id, streamer_id, platform, started_at, ended_at, session_id, hidden, completed, stream_title, viewer_count, breadcrumbs, telemetry, trail_edits";

fn stored_session_from_row(row: &Row<'_>) -> rusqlite::Result<StoredSession> {
    Ok(StoredSession {
        id: row.get(0)?,
        streamer_id: row.get(1)?,
        platform: row.get(2)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        session_id: row.get(5)?,
        hidden: row.get::<_, i32>(6)? != 0,
        completed: row.get::<_, i32>(7)? != 0,
        stream_title: row.get(8)?,
        viewer_count: row.get(9)?,
        breadcrumbs_json: row.get(10)?,
        telemetry_json: row.get(11)?,
        trail_edits_json: row.get(12)?,
    })
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

        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )",
            [],
        )
        .expect("failed to create schema_migrations table");

        run_column_migration(
            &conn,
            1,
            "completed",
            "ALTER TABLE streams ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
        )
        .expect("failed to migrate completed column");
        run_column_migration(
            &conn,
            2,
            "session_id",
            "ALTER TABLE streams ADD COLUMN session_id TEXT",
        )
        .expect("failed to migrate session_id column");
        run_column_migration(
            &conn,
            3,
            "hidden",
            "ALTER TABLE streams ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
        )
        .expect("failed to migrate hidden column");
        run_column_migration(
            &conn,
            4,
            "telemetry",
            "ALTER TABLE streams ADD COLUMN telemetry TEXT",
        )
        .expect("failed to migrate telemetry column");
        run_column_migration(
            &conn,
            5,
            "trail_edits",
            "ALTER TABLE streams ADD COLUMN trail_edits TEXT",
        )
        .expect("failed to migrate trail_edits column");
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
    HistoryRepo::new(&guard)
        .list_sessions(false)
        .unwrap_or_default()
        .into_iter()
        .map(|session| session.to_history_entry())
        .collect()
}

fn unauthorized() -> axum::response::Response {
    (StatusCode::UNAUTHORIZED, "Invalid or missing admin token").into_response()
}

pub async fn admin_list_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AdminListQuery>,
) -> impl IntoResponse {
    if !crate::auth::is_admin_authorized(&headers, &state.companion_api_key) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    let entries = match HistoryRepo::new(&guard).list_sessions(query.all) {
        Ok(sessions) => sessions
            .into_iter()
            .map(|session| session.to_admin_history_entry())
            .collect::<Vec<_>>(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    (StatusCode::OK, Json(entries)).into_response()
}

pub async fn admin_update_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(update): Json<AdminUpdateEntry>,
) -> impl IntoResponse {
    if !crate::auth::is_admin_authorized(&headers, &state.companion_api_key) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    let repo = HistoryRepo::new(&guard);
    if let Some(session_id) = update.session_id {
        if let Err(e) = repo.update_session_id(id, session_id.as_deref()) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    if let Some(hidden) = update.hidden {
        if let Err(e) = repo.set_hidden(id, hidden) {
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
    if !crate::auth::is_admin_authorized(&headers, &state.companion_api_key) {
        return unauthorized();
    }
    edits.hidden_indices.sort_unstable();
    edits.hidden_indices.dedup();
    edits.updated_at = Some(chrono::Utc::now().timestamp_millis());
    edits.updated_by = Some("admin".to_string());
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
    if !crate::auth::is_admin_authorized(&headers, &state.companion_api_key) {
        return unauthorized();
    }
    let history = match &state.history {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "History not configured").into_response(),
    };
    let guard = history.db.lock().await;
    match HistoryRepo::new(&guard).set_hidden(id, true) {
        Ok(0) => (StatusCode::NOT_FOUND, "Session not found").into_response(),
        Ok(_) => (StatusCode::OK, "Hidden").into_response(),
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

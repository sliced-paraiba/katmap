use std::path::PathBuf;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use rusqlite::{params, Connection, Statement};

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
            conn.execute(
                "ALTER TABLE streams ADD COLUMN session_id TEXT",
                [],
            )
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
            conn.execute(
                "ALTER TABLE streams ADD COLUMN telemetry TEXT",
                [],
            )
            .expect("failed to add telemetry column");
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
    let breadcrumbs_json =
        serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;

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
    let breadcrumbs_json =
        serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;

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

pub async fn mark_trail_complete(
    state: &HistoryState,
    trail_id: i64,
    ended_at: i64,
    breadcrumbs: &[[f64; 2]],
    telemetry: Option<&str>,
) -> Result<(), String> {
    let breadcrumbs_json =
        serde_json::to_string(breadcrumbs).map_err(|e| e.to_string())?;
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
            "SELECT id, streamer_id, platform, started_at, ended_at, stream_title, viewer_count, breadcrumbs, telemetry
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
            Ok(HistoryEntry {
                id: row.get(0)?,
                streamer_id: row.get(1)?,
                platform: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                stream_title: row.get(5)?,
                viewer_count: row.get(6)?,
                breadcrumbs,
                telemetry,
            })
        })
        .expect("failed to query");

    rows.filter_map(|r| r.ok()).collect()
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

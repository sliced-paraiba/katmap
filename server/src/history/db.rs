use rusqlite::{Connection, params};

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = ?1"),
        [column],
        |row| row.get(0),
    )
}

fn has_migration(conn: &Connection, version: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1",
        [version],
        |row| row.get(0),
    )
}

fn mark_migration(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
        params![version, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

pub(crate) fn run_column_migration(
    conn: &Connection,
    version: i64,
    column: &str,
    sql: &str,
) -> rusqlite::Result<()> {
    if !has_migration(conn, version)? {
        if !has_column(conn, "streams", column)? {
            conn.execute(sql, [])?;
        }
        mark_migration(conn, version)?;
    }
    Ok(())
}

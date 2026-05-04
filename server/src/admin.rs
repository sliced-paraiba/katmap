use std::env;

use chrono::DateTime;
use rusqlite::Connection;
use serde_json::json;

fn main() {
    let db_path = env::var("HISTORY_DB_PATH")
        .unwrap_or_else(|_| "/opt/katmap/history.db".to_string());

    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }

    let cmd = args.remove(0);

    let conn =
        Connection::open(&db_path).unwrap_or_else(|e| die(&format!("Can't open {db_path}: {e}")));

    match cmd.as_str() {
        "list" => cmd_list(&args, &conn),
        "show" => cmd_show(&mut args, &conn),
        "rename" => cmd_rename(&mut args, &conn),
        "hide" => cmd_hide(&mut args, &conn, true),
        "unhide" => cmd_hide(&mut args, &conn, false),
        "delete" => cmd_delete(&mut args, &conn),
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("Usage: katmap-admin <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  list [--all]      List sessions (default: non-hidden only)");
    eprintln!("  show <id>         Show session details");
    eprintln!("  rename <id> <name>  Rename a session");
    eprintln!("  hide <id>         Hide a session from the web UI");
    eprintln!("  unhide <id>       Unhide a session");
    eprintln!("  delete <id>       Permanently delete a session after JSON backup + typed confirmation");
    std::process::exit(1);
}

fn die(msg: &str) -> ! {
    eprintln!("Error: {msg}");
    std::process::exit(1);
}

fn fmt_ts(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| ms.to_string())
}

fn fmt_duration(start_ms: i64, end_ms: i64) -> String {
    let secs = (end_ms - start_ms) / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    let rem = secs % 60;
    if mins < 60 {
        return format!("{mins}m {rem}s");
    }
    let hrs = mins / 60;
    let rem_mins = mins % 60;
    format!("{hrs}h {rem_mins}m")
}

struct Session {
    id: i64,
    streamer_id: String,
    platform: String,
    started_at: i64,
    ended_at: i64,
    session_id: Option<String>,
    hidden: bool,
    completed: bool,
    stream_title: Option<String>,
    breadcrumbs: String,
}

fn query_sessions(conn: &Connection, include_hidden: bool) -> Vec<Session> {
    let sql = if include_hidden {
        "SELECT id, streamer_id, platform, started_at, ended_at, session_id, hidden, completed, stream_title, breadcrumbs \
         FROM streams ORDER BY started_at DESC"
    } else {
        "SELECT id, streamer_id, platform, started_at, ended_at, session_id, hidden, completed, stream_title, breadcrumbs \
         FROM streams WHERE hidden = 0 ORDER BY started_at DESC"
    };

    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                streamer_id: row.get(1)?,
                platform: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                session_id: row.get(5)?,
                hidden: row.get::<_, i32>(6)? != 0,
                completed: row.get::<_, i32>(7)? != 0,
                stream_title: row.get(8)?,
                breadcrumbs: row.get(9)?,
            })
        })
        .unwrap();

    rows.filter_map(|r| r.ok()).collect()
}

fn cmd_list(args: &[String], conn: &Connection) {
    let all = args.iter().any(|a| a == "--all");
    let sessions = query_sessions(conn, all);

    if sessions.is_empty() {
        println!("No sessions found.");
        return;
    }

    println!("{:<5} {:<5} {:<5} {:<22} {:<10} {}", "ID", "Hidden", "Pts", "Started", "Duration", "Name");
    println!("{}", "─".repeat(72));

    for s in &sessions {
        let pts: usize = serde_json::from_str::<Vec<[f64; 2]>>(&s.breadcrumbs)
            .map(|v| v.len())
            .unwrap_or(0);
        let hide = if s.hidden { "yes" } else { "" };
        let name = s.session_id.as_deref().unwrap_or(&s.streamer_id);
        let dur = fmt_duration(s.started_at, s.ended_at);
        let incomplete = if !s.completed { " ⏳" } else { "" };
        println!(
            "{:<5} {:<5} {:<5} {:<22} {:<10} {}{}",
            s.id, hide, pts, fmt_ts(s.started_at), dur, name, incomplete,
        );
    }
}

fn cmd_show(args: &mut Vec<String>, conn: &Connection) {
    if args.is_empty() {
        die("Usage: katmap-admin show <id>");
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));

    let s: Session = conn
        .query_row(
            "SELECT id, streamer_id, platform, started_at, ended_at, session_id, hidden, completed, stream_title, breadcrumbs \
             FROM streams WHERE id = ?1",
            [id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    streamer_id: row.get(1)?,
                    platform: row.get(2)?,
                    started_at: row.get(3)?,
                    ended_at: row.get(4)?,
                    session_id: row.get(5)?,
                    hidden: row.get::<_, i32>(6)? != 0,
                    completed: row.get::<_, i32>(7)? != 0,
                    stream_title: row.get(8)?,
                    breadcrumbs: row.get(9)?,
                })
            },
        )
        .unwrap_or_else(|_| die(&format!("Session {id} not found")));

    let pts: Vec<[f64; 2]> = serde_json::from_str(&s.breadcrumbs).unwrap_or_default();

    println!("ID:          {}", s.id);
    println!("Name:        {}", s.session_id.as_deref().unwrap_or("(none)"));
    println!("Streamer:    {}", s.streamer_id);
    println!("Platform:    {}", s.platform);
    println!("Started:     {}", fmt_ts(s.started_at));
    println!("Ended:       {}", fmt_ts(s.ended_at));
    println!("Duration:    {}", fmt_duration(s.started_at, s.ended_at));
    println!("Points:      {}", pts.len());
    println!("Completed:   {}", if s.completed { "yes" } else { "no" });
    println!("Hidden:      {}", if s.hidden { "yes" } else { "no" });
    if let Some(ref title) = s.stream_title {
        println!("Title:       {title}");
    }
    if !pts.is_empty() {
        println!("\nTrail:");
        for (i, [lon, lat]) in pts.iter().enumerate() {
            println!("  {:>3}. {lat:.5}, {lon:.5}", i + 1);
        }
    }
}

fn cmd_rename(args: &mut Vec<String>, conn: &Connection) {
    if args.len() < 2 {
        die("Usage: katmap-admin rename <id> <name>");
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));
    let name = args.join(" ");

    let changed = conn
        .execute(
            "UPDATE streams SET session_id = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .unwrap_or_else(|e| die(&e.to_string()));

    if changed == 0 {
        die(&format!("Session {id} not found"));
    }
    println!("Session {id} renamed to \"{name}\"");
}

fn cmd_hide(args: &mut Vec<String>, conn: &Connection, hide: bool) {
    if args.is_empty() {
        die(&format!(
            "Usage: katmap-admin {} <id>",
            if hide { "hide" } else { "unhide" }
        ));
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));

    let changed = conn
        .execute(
            "UPDATE streams SET hidden = ?1 WHERE id = ?2",
            rusqlite::params![hide as i32, id],
        )
        .unwrap_or_else(|e| die(&e.to_string()));

    if changed == 0 {
        die(&format!("Session {id} not found"));
    }
    println!(
        "Session {id} {}",
        if hide { "hidden" } else { "unhidden" }
    );
}

fn cmd_delete(args: &mut Vec<String>, conn: &Connection) {
    if args.is_empty() {
        die("Usage: katmap-admin delete <id>");
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));

    let backup = conn
        .query_row(
            "SELECT id, streamer_id, platform, started_at, ended_at, stream_title, viewer_count, breadcrumbs, completed, session_id, hidden, telemetry, trail_edits
             FROM streams WHERE id = ?1",
            [id],
            |row| {
                let session_id: Option<String> = row.get(9)?;
                let streamer_id: String = row.get(1)?;
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "streamer_id": streamer_id,
                    "platform": row.get::<_, String>(2)?,
                    "started_at": row.get::<_, i64>(3)?,
                    "ended_at": row.get::<_, i64>(4)?,
                    "stream_title": row.get::<_, Option<String>>(5)?,
                    "viewer_count": row.get::<_, Option<i32>>(6)?,
                    "breadcrumbs": row.get::<_, String>(7)?,
                    "completed": row.get::<_, i32>(8)? != 0,
                    "session_id": session_id,
                    "hidden": row.get::<_, i32>(10)? != 0,
                    "telemetry": row.get::<_, Option<String>>(11)?,
                    "trail_edits": row.get::<_, Option<String>>(12)?,
                }))
            },
        )
        .unwrap_or_else(|_| die(&format!("Session {id} not found")));

    let name = backup
        .get("session_id")
        .and_then(|v| v.as_str())
        .or_else(|| backup.get("streamer_id").and_then(|v| v.as_str()))
        .unwrap_or("unknown");
    let backup_path = format!(
        "history-delete-backup-{id}-{}.json",
        chrono::Utc::now().timestamp_millis()
    );
    let pretty = serde_json::to_string_pretty(&backup).unwrap_or_else(|e| die(&e.to_string()));
    std::fs::write(&backup_path, pretty).unwrap_or_else(|e| die(&format!("Backup failed: {e}")));

    eprintln!("Backup written to {backup_path}");
    eprint!("Type session id {id} to permanently delete \"{name}\": ");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).ok();
    if input.trim() != id.to_string() {
        eprintln!("Cancelled. Backup retained at {backup_path}.");
        return;
    }

    let changed = conn
        .execute("DELETE FROM streams WHERE id = ?1", [id])
        .unwrap_or_else(|e| die(&e.to_string()));

    if changed == 0 {
        die(&format!("Session {id} not found"));
    }
    println!("Session {id} deleted.");
}

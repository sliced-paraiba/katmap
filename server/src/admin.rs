use std::env;

use chrono::DateTime;
use katmap_server::history::{HistoryRepo, StoredSession, db_path};
use rusqlite::Connection;
use serde_json::json;

fn main() {
    let db_path = db_path();

    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }

    let cmd = args.remove(0);

    let conn = Connection::open(&db_path)
        .unwrap_or_else(|e| die(&format!("Can't open {}: {e}", db_path.display())));

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
    eprintln!(
        "  delete <id>       Permanently delete a session after JSON backup + typed confirmation"
    );
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

fn get_session_or_die(conn: &Connection, id: i64) -> StoredSession {
    HistoryRepo::new(conn)
        .get_session(id)
        .unwrap_or_else(|e| die(&e.to_string()))
        .unwrap_or_else(|| die(&format!("Session {id} not found")))
}

fn cmd_list(args: &[String], conn: &Connection) {
    let all = args.iter().any(|a| a == "--all");
    let sessions = HistoryRepo::new(conn)
        .list_sessions(all)
        .unwrap_or_else(|e| die(&e.to_string()));

    if sessions.is_empty() {
        println!("No sessions found.");
        return;
    }

    println!(
        "{:<5} {:<5} {:<5} {:<22} {:<10} Name",
        "ID", "Hidden", "Pts", "Started", "Duration"
    );
    println!("{}", "─".repeat(72));

    for s in &sessions {
        let pts = s.point_count();
        let hide = if s.hidden { "yes" } else { "" };
        let name = s.display_name();
        let dur = fmt_duration(s.started_at, s.ended_at);
        let incomplete = if !s.completed { " ⏳" } else { "" };
        println!(
            "{:<5} {:<5} {:<5} {:<22} {:<10} {}{}",
            s.id,
            hide,
            pts,
            fmt_ts(s.started_at),
            dur,
            name,
            incomplete,
        );
    }
}

fn cmd_show(args: &mut Vec<String>, conn: &Connection) {
    if args.is_empty() {
        die("Usage: katmap-admin show <id>");
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));

    let s = get_session_or_die(conn, id);
    let pts = s.breadcrumbs();

    println!("ID:          {}", s.id);
    println!(
        "Name:        {}",
        s.session_id.as_deref().unwrap_or("(none)")
    );
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

    let changed = HistoryRepo::new(conn)
        .update_session_id(id, Some(&name))
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

    let changed = HistoryRepo::new(conn)
        .set_hidden(id, hide)
        .unwrap_or_else(|e| die(&e.to_string()));

    if changed == 0 {
        die(&format!("Session {id} not found"));
    }
    println!("Session {id} {}", if hide { "hidden" } else { "unhidden" });
}

fn cmd_delete(args: &mut Vec<String>, conn: &Connection) {
    if args.is_empty() {
        die("Usage: katmap-admin delete <id>");
    }
    let id: i64 = args.remove(0).parse().unwrap_or_else(|_| die("Invalid id"));

    let session = get_session_or_die(conn, id);
    let backup = session_backup_json(&session);

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

    let changed = HistoryRepo::new(conn)
        .delete_session(id)
        .unwrap_or_else(|e| die(&e.to_string()));

    if changed == 0 {
        die(&format!("Session {id} not found"));
    }
    println!("Session {id} deleted.");
}

fn session_backup_json(session: &StoredSession) -> serde_json::Value {
    json!({
        "id": session.id,
        "streamer_id": session.streamer_id,
        "platform": session.platform,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "stream_title": session.stream_title,
        "viewer_count": session.viewer_count,
        "breadcrumbs": session.breadcrumbs_json,
        "completed": session.completed,
        "session_id": session.session_id,
        "hidden": session.hidden,
        "telemetry": session.telemetry_json,
        "trail_edits": session.trail_edits_json,
    })
}

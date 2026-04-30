use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=KATMAP_GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=KATMAP_BUILD_TIME");

    let commit = std::env::var("KATMAP_GIT_COMMIT")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());

    let build_time = std::env::var("KATMAP_BUILD_TIME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=KATMAP_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=KATMAP_BUILD_TIME={build_time}");
}

use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::runtime_bundle::{bundled_root_from_exe, runtime_root, seed_runtime_from_bundle};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn get_repo_root() -> PathBuf {
    // Bundled production mode: copy to writable app data dir
    if let Some(bundled_root) = bundled_root_from_exe() {
        let runtime = runtime_root();
        seed_runtime_from_bundle(&bundled_root, &runtime);
        return runtime;
    }

    // Dev mode: walk up from cwd
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(_) => return PathBuf::from("."),
    };

    let mut current = cwd.clone();
    for _ in 0..5 {
        if current.join("relay").join("server.js").exists()
            && current
                .join("agnt-bridge")
                .join("bin")
                .join("agnt.js")
                .exists()
        {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    current = cwd.clone();
    for _ in 0..2 {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }
    current
}

pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) fn ensure_deps(dir: &Path, app_handle: &tauri::AppHandle) -> bool {
    let node_modules = dir.join("node_modules");
    let package_json = dir.join("package.json");

    if !package_json.exists() {
        return true;
    }

    if node_modules.exists() {
        return true;
    }

    crate::add_log(
        app_handle,
        "app",
        "info",
        &format!("Installing dependencies in {}...", dir.display()),
    );

    let output = if cfg!(windows) {
        let cmd = format!(
            "cd /d {} && npm install --no-audit --no-fund --silent",
            dir.display()
        );
        let mut c = Command::new("cmd");
        c.args(["/C", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut c);
        c.output()
    } else {
        Command::new("npm")
            .args(["install", "--no-audit", "--no-fund", "--silent"])
            .current_dir(dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    };

    match output {
        Ok(out) if out.status.success() => {
            crate::add_log(
                app_handle,
                "app",
                "info",
                &format!("Dependencies installed in {}", dir.display()),
            );
            true
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            crate::add_log(
                app_handle,
                "app",
                "error",
                &format!("npm install failed: {}{}", stderr, stdout),
            );
            false
        }
        Err(e) => {
            crate::add_log(
                app_handle,
                "app",
                "error",
                &format!("Failed to run npm install: {}", e),
            );
            false
        }
    }
}

pub(crate) fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub(crate) fn find_available_port(start: u16) -> u16 {
    (start..start + 100)
        .find(|&p| is_port_available(p))
        .unwrap_or(9000)
}

pub(crate) fn wait_for_port(port: u16, timeout_secs: u32) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    for _ in 0..(timeout_secs * 10) {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

pub(crate) fn pipe_stdout_to_logs(
    stdout: std::process::ChildStdout,
    app_handle: tauri::AppHandle,
    source: String,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(text) = line {
                if !text.trim().is_empty() {
                    crate::add_log(&app_handle, &source, "info", &text);
                }
            }
        }
    });
}

pub(crate) fn pipe_stderr_to_logs(
    stderr: std::process::ChildStderr,
    app_handle: tauri::AppHandle,
    source: String,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(text) = line {
                if !text.trim().is_empty() {
                    crate::add_log(&app_handle, &source, "error", &text);
                }
            }
        }
    });
}

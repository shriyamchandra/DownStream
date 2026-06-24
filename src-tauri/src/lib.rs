use std::sync::Mutex;
use std::io::Read;
use std::process::Child;
use tauri::Manager;
use include_dir::{include_dir, Dir};

static PUBLIC_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../public");

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Settings {
    #[serde(rename = "preferredPlayer")]
    preferred_player: String,
    #[serde(rename = "downloadDir")]
    download_dir: String,
}

pub struct AriaProcess(pub Mutex<Option<Child>>);

// True only if `target` is inside `base`. Rejects any ".." component so paths
// like "<base>/../../etc/passwd" can't escape the download sandbox (Path::starts_with
// alone treats ".." as an ordinary component and would let it through).
fn path_within(base: &str, target: &str) -> bool {
    let target_path = std::path::Path::new(target);
    if target_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    target_path.starts_with(std::path::Path::new(base))
}

fn get_config_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    let mut path = app_handle.path().app_config_dir().unwrap_or_else(|_| {
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
    });
    std::fs::create_dir_all(&path).ok();
    path.push("config.json");
    path
}

fn get_session_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    let mut path = app_handle.path().app_config_dir().unwrap_or_else(|_| {
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
    });
    std::fs::create_dir_all(&path).ok();
    path.push("aria2.session");
    path
}

#[tauri::command]
fn load_settings(app_handle: tauri::AppHandle) -> Settings {
    let path = get_config_path(&app_handle);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                return settings;
            }
        }
    }
    // Default config
    let default_dir = format!("{}/Downloads/DownStream", std::env::var("HOME").unwrap_or_default());
    Settings {
        preferred_player: "vlc".to_string(),
        download_dir: default_dir,
    }
}

#[tauri::command]
fn save_settings(app_handle: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = get_config_path(&app_handle);
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn stream_file(filename: String, download_dir: String, preferred_player: String) -> Result<(), String> {
    fn find_file(dir: &std::path::Path, target: &str) -> Option<std::path::PathBuf> {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(found) = find_file(&path, target) {
                        return Some(found);
                    }
                } else if path.file_name().and_then(|n| n.to_str()) == Some(target) {
                    return Some(path);
                }
            }
        }
        None
    }

    let search_dir = std::path::Path::new(&download_dir);
    let filepath = find_file(search_dir, &filename)
        .ok_or_else(|| "File not found on disk yet.".to_string())?;

    if let Ok(metadata) = std::fs::metadata(&filepath) {
        if metadata.len() < 200_000 {
            return Err("Buffer not reached. File is < 200KB.".to_string());
        }
    } else {
        return Err("Could not read file size.".to_string());
    }

    let mut args = Vec::new();
    if preferred_player == "vlc" {
        args.extend_from_slice(&["-a", "VLC"]);
    } else if preferred_player == "iina" {
        args.extend_from_slice(&["-a", "IINA"]);
    } else if preferred_player == "mpv" {
        args.extend_from_slice(&["-a", "mpv"]);
    }

    let path_str = filepath.to_str().ok_or("Invalid path encoding")?;
    args.push(path_str);

    std::process::Command::new("open")
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_file(filepath: String, download_dir: String) -> Result<(), String> {
    let path = std::path::Path::new(&filepath);

    if !path_within(&download_dir, &filepath) {
        return Err("Path traversal blocked.".to_string());
    }

    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    
    let control_path_str = format!("{}.aria2", filepath);
    let control_path = std::path::Path::new(&control_path_str);
    if control_path.exists() {
        std::fs::remove_file(control_path).ok();
    }

    Ok(())
}

#[tauri::command]
fn show_in_finder(filepath: String, download_dir: String) -> Result<(), String> {
    if !path_within(&download_dir, &filepath) {
        return Err("Path traversal blocked.".to_string());
    }

    std::process::Command::new("open")
        .args(&["-R", &filepath])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn show_notification(title: String, message: String) -> Result<(), String> {
    // Escape backslashes first, then quotes, so the AppleScript string literal
    // can't be broken out of (e.g. a message ending in '\').
    let escaped_title = title.replace("\\", "\\\\").replace("\"", "\\\"");
    let escaped_message = message.replace("\\", "\\\\").replace("\"", "\\\"");
    
    let applescript = format!(
        "display notification \"{}\" with title \"{}\"",
        escaped_message, escaped_title
    );

    std::process::Command::new("osascript")
        .args(&["-e", &applescript])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn aria2_rpc(method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "tauri_client",
        "method": format!("aria2.{}", method),
        "params": params
    });

    let resp: serde_json::Value = ureq::post("http://127.0.0.1:6800/jsonrpc")
        .send_json(payload)
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp.get("error") {
        return Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("RPC Error").to_string());
    }

    Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            stream_file,
            delete_file,
            show_in_finder,
            show_notification,
            aria2_rpc
        ])
        .setup(|app| {
            let settings = load_settings(app.handle().clone());
            let session_path = get_session_path(app.handle());
            
            // Ensure download directory exists
            std::fs::create_dir_all(&settings.download_dir).ok();
            
            // Ensure session file exists
            if !session_path.exists() {
                std::fs::write(&session_path, "").ok();
            }

            // Start embedded HTTP server for frontend assets + API
            let server = tiny_http::Server::http("127.0.0.1:0").expect("Failed to start asset server");
            let asset_port = server.server_addr().to_ip().unwrap().port();
            println!("Asset server listening on port {}", asset_port);

            // Share config with server thread
            let server_config = std::sync::Arc::new(Mutex::new(settings.clone()));
            let server_config_clone = server_config.clone();
            let config_path = get_config_path(app.handle());

            std::thread::spawn(move || {
                for mut request in server.incoming_requests() {
                    let url = request.url().to_string();
                    let method = request.method().to_string();

                    // API routes
                    if url.starts_with("/api/") {
                        let json_header = tiny_http::Header::from_bytes(
                            &b"Content-Type"[..], &b"application/json"[..]
                        ).unwrap();

                        // Read body for POST
                        let mut body = String::new();
                        if method == "POST" {
                            request.as_reader().read_to_string(&mut body).ok();
                        }

                        if url == "/api/settings" && method == "GET" {
                            let cfg = server_config_clone.lock().unwrap();
                            let json = serde_json::to_string(&*cfg).unwrap_or_default();
                            request.respond(
                                tiny_http::Response::from_string(json).with_header(json_header.clone())
                            ).ok();
                        } else if url == "/api/settings" && method == "POST" {
                            if let Ok(new_cfg) = serde_json::from_str::<Settings>(&body) {
                                let mut cfg = server_config_clone.lock().unwrap();
                                *cfg = new_cfg.clone();
                                if let Ok(content) = serde_json::to_string_pretty(&new_cfg) {
                                    std::fs::write(&config_path, content).ok();
                                }
                                let resp = format!("{{\"success\":true,\"config\":{}}}", serde_json::to_string(&new_cfg).unwrap_or_default());
                                request.respond(
                                    tiny_http::Response::from_string(resp).with_header(json_header.clone())
                                ).ok();
                            }
                        } else if url == "/api/stream" && method == "POST" {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                                let filename = data.get("filename").and_then(|v| v.as_str()).unwrap_or("");
                                let cfg = server_config_clone.lock().unwrap();
                                match stream_file(filename.to_string(), cfg.download_dir.clone(), cfg.preferred_player.clone()) {
                                    Ok(()) => {
                                        request.respond(
                                            tiny_http::Response::from_string("{\"success\":true}").with_header(json_header.clone())
                                        ).ok();
                                    }
                                    Err(e) => {
                                        let resp = format!("{{\"error\":\"{}\"}}", e);
                                        request.respond(
                                            tiny_http::Response::from_string(resp).with_header(json_header.clone())
                                        ).ok();
                                    }
                                }
                            }
                        } else if url == "/api/delete" && method == "POST" {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                                let filepath = data.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
                                let cfg = server_config_clone.lock().unwrap();
                                delete_file(filepath.to_string(), cfg.download_dir.clone()).ok();
                                request.respond(
                                    tiny_http::Response::from_string("{\"success\":true}").with_header(json_header.clone())
                                ).ok();
                            }
                        } else if url == "/api/showInFinder" && method == "POST" {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                                let filepath = data.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
                                let cfg = server_config_clone.lock().unwrap();
                                show_in_finder(filepath.to_string(), cfg.download_dir.clone()).ok();
                                request.respond(
                                    tiny_http::Response::from_string("{\"success\":true}").with_header(json_header.clone())
                                ).ok();
                            }
                        } else if url == "/api/notify" && method == "POST" {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                                let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("");
                                let message = data.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                show_notification(title.to_string(), message.to_string()).ok();
                                request.respond(
                                    tiny_http::Response::from_string("{\"success\":true}").with_header(json_header.clone())
                                ).ok();
                            }
                        } else {
                            request.respond(
                                tiny_http::Response::from_string("{\"error\":\"unknown endpoint\"}").with_status_code(404)
                            ).ok();
                        }
                        continue;
                    }

                    // Static file serving
                    let url_path = url.trim_start_matches('/');
                    let file_path = if url_path.is_empty() { "index.html" } else { url_path };
                    
                    if let Some(file) = PUBLIC_DIR.get_file(file_path) {
                        let content_type = match file_path.rsplit('.').next() {
                            Some("html") => "text/html; charset=utf-8",
                            Some("css") => "text/css; charset=utf-8",
                            Some("js") => "application/javascript; charset=utf-8",
                            Some("json") => "application/json",
                            Some("png") => "image/png",
                            Some("svg") => "image/svg+xml",
                            Some("ico") => "image/x-icon",
                            _ => "application/octet-stream",
                        };
                        let response = tiny_http::Response::from_data(file.contents())
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    content_type.as_bytes()
                                ).unwrap()
                            );
                        request.respond(response).ok();
                    } else {
                        let response = tiny_http::Response::from_string("Not Found")
                            .with_status_code(404);
                        request.respond(response).ok();
                    }
                }
            });

            // Open the app in the default browser
            // (WKWebView is broken on macOS 26 Tahoe - known regression)
            let url_str = format!("http://127.0.0.1:{}", asset_port);
            println!("Opening {} in default browser", url_str);
            std::process::Command::new("open")
                .arg(&url_str)
                .spawn()
                .ok();

            // Find aria2c path
            let mut aria2c_path = "aria2c".to_string();
            if let Ok(output) = std::process::Command::new("which").arg("aria2c").output() {
                if output.status.success() {
                    if let Ok(path_str) = String::from_utf8(output.stdout) {
                        let trimmed = path_str.trim();
                        if !trimmed.is_empty() {
                            aria2c_path = trimmed.to_string();
                        }
                    }
                }
            }
            if aria2c_path == "aria2c" {
                if std::path::Path::new("/opt/homebrew/bin/aria2c").exists() {
                    aria2c_path = "/opt/homebrew/bin/aria2c".to_string();
                } else if std::path::Path::new("/usr/local/bin/aria2c").exists() {
                    aria2c_path = "/usr/local/bin/aria2c".to_string();
                }
            }

            // Spawn aria2c daemon
            let child = std::process::Command::new(&aria2c_path)
                .args(&[
                    "--enable-rpc=true",
                    "--rpc-allow-origin-all=true",
                    "--rpc-listen-all=true",
                    "--rpc-listen-port=6800",
                    &format!("--dir={}", settings.download_dir),
                    "--stream-piece-selector=inorder",
                    "--allow-overwrite=true",
                    "-x", "16", "-s", "16", "-c",
                    "--file-allocation=none",
                    "--auto-file-renaming=false",
                    &format!("--input-file={}", session_path.display()),
                    &format!("--save-session={}", session_path.display()),
                    "--save-session-interval=10",
                ])
                .spawn();

            if let Ok(c) = child {
                app.manage(AriaProcess(Mutex::new(Some(c))));
            } else {
                println!("Warning: Failed to launch aria2c process. Make sure it is installed.");
                app.manage(AriaProcess(Mutex::new(None)));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(aria_state) = app_handle.try_state::<AriaProcess>() {
                if let Ok(mut lock) = aria_state.0.lock() {
                    if let Some(mut child) = lock.take() {
                        child.kill().ok();
                    }
                }
            }
        }
    });
}

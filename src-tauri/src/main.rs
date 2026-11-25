#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const ENGINE_PORT: u16 = 8787;

struct EngineState(Mutex<Option<Child>>);
struct Quitting(Mutex<bool>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(EngineState(Mutex::new(None)))
        .manage(Quitting(Mutex::new(false)))
        .setup(|app| {
            spawn_engine(app.handle());

            if env::var_os("CLUBIFY_SHOW").is_some()
                || env::args().any(|argument| argument == "--show")
            {
                show_window(app.handle());
            }
            if let Ok(milliseconds) = env::var("CLUBIFY_EXIT_AFTER_MS") {
                if let Ok(milliseconds) = milliseconds.parse::<u64>() {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(milliseconds));
                        handle.exit(0);
                    });
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Open Clubify", true, None::<&str>)?;
            let manager = app.autolaunch();
            let autostart_allowed = env::var_os("CLUBIFY_NO_AUTOSTART").is_none();
            if !cfg!(debug_assertions) && autostart_allowed {
                let config_dir = app.path().app_config_dir().ok();
                let marker = config_dir
                    .as_ref()
                    .map(|directory| directory.join("autostart-initialized"));
                let initialized = marker.as_ref().map(|path| path.exists()).unwrap_or(false);
                if !initialized && manager.enable().is_ok() {
                    if let (Some(directory), Some(path)) = (config_dir, marker) {
                        let _ = std::fs::create_dir_all(directory);
                        let _ = std::fs::write(path, b"1");
                    }
                }
            }
            let autostart_enabled = manager.is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start with Windows",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &autostart_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            let autostart_toggle = autostart_item.clone();
            let mut tray = TrayIconBuilder::new()
                .tooltip("Clubify")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "autostart" => {
                        let manager = app.autolaunch();
                        let enabled = manager.is_enabled().unwrap_or(false);
                        let next = if enabled {
                            let _ = manager.disable();
                            false
                        } else {
                            manager.enable().is_ok()
                        };
                        let _ = autostart_toggle.set_checked(next);
                    }
                    "quit" => {
                        *app.state::<Quitting>().0.lock().unwrap() = true;
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let quitting = *app.state::<Quitting>().0.lock().unwrap();
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Clubify")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_engine(app);
            }
        });
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn spawn_engine(app: &tauri::AppHandle) {
    if engine_is_healthy() {
        return;
    }
    if let Ok(state) = app.state::<EngineState>().0.lock() {
        if state.is_some() {
            return;
        }
    }

    let mut command: Command;
    if let Ok(binary) = env::var("CLUBIFY_ENGINE_BIN") {
        command = Command::new(binary);
    } else if cfg!(debug_assertions) && env::var_os("CLUBIFY_PACKAGED").is_none() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        command = Command::new("node");
        command
            .args(["--import", "tsx", "src/index.ts"])
            .current_dir(project_root);
    } else {
        let resource_dir = apply_resource_dir_fix(
            app.path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from(".")),
        );
        let engine_dir = resource_dir.join("engine");
        let packaged_node = resource_dir.join("node.exe");
        command = if packaged_node.exists() {
            Command::new(packaged_node)
        } else {
            Command::new("node")
        };
        command
            .arg(engine_dir.join("dist").join("index.js"))
            .current_dir(engine_dir);
    }

    eprintln!("[clubify] starting audio engine: {command:?}");

    command.stdin(Stdio::null());
    let debug_console =
        cfg!(debug_assertions) || env::var_os("CLUBIFY_DEBUG_CONSOLE").is_some();
    if debug_console {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    match command.spawn() {
        Ok(child) => {
            if let Ok(mut state) = app.state::<EngineState>().0.lock() {
                *state = Some(child);
            }
        }
        Err(error) => eprintln!("[clubify] could not start audio engine: {error}"),
    }
}

fn stop_engine(app: &tauri::AppHandle) {
    if let Ok(mut state) = app.state::<EngineState>().0.lock() {
        if let Some(mut child) = state.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn engine_is_healthy() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], ENGINE_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(
        b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn apply_resource_dir_fix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(stripped) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

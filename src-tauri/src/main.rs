#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    ffi::c_void,
    fs::OpenOptions,
    io::{Read, Write},
    mem::size_of,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_updater::UpdaterExt;

const ENGINE_PORT: u16 = 8787;
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const UPDATE_LOG_LIMIT_BYTES: u64 = 256 * 1024;
const WINDOW_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");

struct EngineState(Mutex<Option<EngineProcess>>);
struct Quitting(Mutex<bool>);

struct EngineProcess {
    child: Child,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

#[cfg(windows)]
struct JobHandle(isize);

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(HANDLE(self.0 as *mut c_void)) };
    }
}

#[cfg(windows)]
fn create_engine_job(child: &Child) -> Option<JobHandle> {
    unsafe {
        let job = match CreateJobObjectW(None, None) {
            Ok(job) => job,
            Err(error) => {
                eprintln!("[clubify] could not create engine job: {error}");
                return None;
            }
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            eprintln!("[clubify] could not configure engine job: {error}");
            let _ = CloseHandle(job);
            return None;
        }
        if let Err(error) = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) {
            eprintln!("[clubify] could not assign engine to job: {error}");
            let _ = CloseHandle(job);
            return None;
        }
        Some(JobHandle(job.0 as isize))
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineState(Mutex::new(None)))
        .manage(Quitting(Mutex::new(false)))
        .setup(|app| {
            spawn_engine(app.handle());
            spawn_update_check(app.handle().clone());

            apply_window_icon(app.handle());

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
            if let Ok(icon) = tauri::image::Image::from_bytes(WINDOW_ICON_BYTES) {
                tray = tray.icon(icon);
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

fn apply_window_icon(app: &tauri::AppHandle) {
    let Ok(icon) = tauri::image::Image::from_bytes(WINDOW_ICON_BYTES) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_icon(icon);
    }
}

fn spawn_update_check(app: tauri::AppHandle) {
    if cfg!(debug_assertions) && env::var_os("CLUBIFY_UPDATE_CHECK").is_none() {
        return;
    }

    std::thread::spawn(move || loop {
        check_for_update(&app);
        std::thread::sleep(update_check_interval());
    });
}

fn check_for_update(app: &tauri::AppHandle) {
    let stop_handle = app.clone();
    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .on_before_exit(move || stop_engine(&stop_handle))
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            log_update(app, &format!("updater unavailable: {error}"));
            return;
        }
    };

    let current_version = app.package_info().version.clone();
    log_update(
        app,
        &format!("checking for updates (current {current_version})"),
    );

    match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(update)) => {
            log_update(
                app,
                &format!(
                    "installing update {} (current {})",
                    update.version, update.current_version
                ),
            );
            let install =
                tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}));
            if let Err(error) = install {
                log_update(
                    app,
                    &format!("update to {} failed: {error}", update.version),
                );
                spawn_engine(app);
                return;
            }
            #[cfg(not(windows))]
            app.restart();
        }
        Ok(None) => log_update(
            app,
            &format!("no update available (current {current_version})"),
        ),
        Err(error) => log_update(app, &format!("update check failed: {error}")),
    }
}

fn update_check_interval() -> Duration {
    env::var("CLUBIFY_UPDATE_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .unwrap_or(UPDATE_CHECK_INTERVAL)
}

fn log_update(app: &tauri::AppHandle, message: &str) {
    eprintln!("[clubify] {message}");

    let Ok(log_dir) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("updater.log");
    let oversized = std::fs::metadata(&path)
        .map(|metadata| metadata.len() > UPDATE_LOG_LIMIT_BYTES)
        .unwrap_or(false);
    if oversized {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {message}", utc_timestamp());
    }
}

fn utc_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let days = (seconds / 86_400) as i64;
    let clock = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        clock / 3_600,
        clock % 3_600 / 60,
        clock % 60
    )
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_unix_epoch + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = month_index + if month_index < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
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
            #[cfg(windows)]
            let process = EngineProcess {
                job: create_engine_job(&child),
                child,
            };
            #[cfg(not(windows))]
            let process = EngineProcess { child };
            if let Ok(mut state) = app.state::<EngineState>().0.lock() {
                *state = Some(process);
            }
        }
        Err(error) => eprintln!("[clubify] could not start audio engine: {error}"),
    }
}

fn stop_engine(app: &tauri::AppHandle) {
    if let Ok(mut state) = app.state::<EngineState>().0.lock() {
        if let Some(mut process) = state.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
            // Keep the job handle alive until after the child is reaped. The
            // handle's Drop closes it; KILL_ON_JOB_CLOSE then also covers a
            // crash of the Tauri process itself.
            #[cfg(windows)]
            let _job = process.job.as_ref();
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

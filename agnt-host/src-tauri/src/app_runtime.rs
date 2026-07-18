use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use crate::{
    add_log, bridge_runtime, host_config::AppConfig, pet_window, process_runtime,
    runtime_bundle::refresh_runtime_from_bundle,
};

pub fn setup(
    app: &mut tauri::App,
    app_config: AppConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )?;
    }

    match refresh_runtime_from_bundle(false) {
        Ok(status) if status.runtime_current => {
            add_log(
                app.handle(),
                "app",
                "info",
                "Runtime bridge and relay are current",
            );
        }
        Ok(status) if status.refresh_available => {
            add_log(app.handle(), "app", "warning", &status.message);
        }
        Ok(_) => {}
        Err(error) => {
            add_log(
                app.handle(),
                "app",
                "error",
                &format!("Runtime refresh failed: {error}"),
            );
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = w.hide();
            }
        });
    }

    if app_config.start_minimized {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }

    pet_window::create_pet_windows(app, app_config.relay_mode == "local")?;

    if !app_config.setup_completed {
        let h = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            let _ = h.emit("first-run", ());
        });
    }

    let show = MenuItemBuilder::with_id("show", "Show Agnt Host").build(app)?;
    let show_qr = MenuItemBuilder::with_id("show_qr", "Show QR").build(app)?;
    let start = MenuItemBuilder::with_id("start", "Start All").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Stop All").build(app)?;
    let restart_bridge = MenuItemBuilder::with_id("restart_bridge", "Restart Bridge").build(app)?;
    let restart_relay = MenuItemBuilder::with_id("restart_relay", "Restart Relay").build(app)?;
    let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let logs = MenuItemBuilder::with_id("open_logs", "Open Logs").build(app)?;
    let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&show_qr)
        .separator()
        .item(&start)
        .item(&stop)
        .item(&restart_bridge)
        .item(&restart_relay)
        .item(&sep1)
        .item(&logs)
        .item(&sep2)
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("Agnt Host")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "show_qr" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("show-qr", ());
                }
            }
            "start" => {
                let handle = app.app_handle().clone();
                let _ = process_runtime::start_all(handle);
            }
            "stop" => {
                let handle = app.app_handle().clone();
                let _ = process_runtime::stop_all(handle);
            }
            "restart_bridge" => {
                let handle = app.app_handle().clone();
                let _ = bridge_runtime::stop_bridge(handle.clone());
                std::thread::sleep(Duration::from_millis(500));
                let _ = bridge_runtime::start_bridge(handle);
            }
            "restart_relay" => {
                let handle = app.app_handle().clone();
                let _ = process_runtime::stop_relay(handle.clone());
                std::thread::sleep(Duration::from_millis(500));
                let _ = process_runtime::start_relay(handle);
            }
            "open_logs" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                let handle = app.app_handle().clone();
                let _ = process_runtime::stop_all(handle);
                std::thread::sleep(Duration::from_millis(500));
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
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

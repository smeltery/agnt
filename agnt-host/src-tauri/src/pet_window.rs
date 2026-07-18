use crate::app_types::AppState;
use tauri::Manager;

const PET_WINDOW_SIZE: f64 = 80.0;

pub(crate) fn create_pet_windows(app: &mut tauri::App, visible: bool) -> tauri::Result<()> {
    let screen_width = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.size().width as f64)
        .unwrap_or(1920.0);

    let _pet =
        tauri::WebviewWindowBuilder::new(app, "pet", tauri::WebviewUrl::App("pet.html".into()))
            .title("Agnt Pet")
            .inner_size(PET_WINDOW_SIZE, PET_WINDOW_SIZE)
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .visible(visible)
            .position(screen_width - 120.0, 200.0)
            .build()?;

    let _pet_popup = tauri::WebviewWindowBuilder::new(
        app,
        "pet-popup",
        tauri::WebviewUrl::App("popup.html".into()),
    )
    .title("Agnt")
    .inner_size(260.0, 220.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .visible(false)
    .center()
    .build()?;

    Ok(())
}

#[tauri::command]
pub(crate) fn show_pet_popup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let pairing_payload = state
        .pairing_payload
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if pairing_payload.is_none() {
        if let Some(w) = app_handle.get_webview_window("pet-popup") {
            let _ = w.hide();
        }
        return Ok(());
    }

    let pet_pos = app_handle
        .get_webview_window("pet")
        .and_then(|pet| pet.outer_position().ok());
    let popup_x = pet_pos.map(|pos| (pos.x - 90).max(0)).unwrap_or(0);
    let popup_y = pet_pos.map(|pos| (pos.y - 222).max(0)).unwrap_or(0);

    if let Some(w) = app_handle.get_webview_window("pet-popup") {
        w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            popup_x, popup_y,
        )))
        .map_err(|e| format!("popup position failed: {e}"))?;
        w.show().map_err(|e| format!("popup show failed: {e}"))?;
        return Ok(());
    }

    let _popup = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "pet-popup",
        tauri::WebviewUrl::App("popup.html".into()),
    )
    .title("")
    .inner_size(260.0, 220.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .visible(true)
    .position(popup_x as f64, popup_y as f64)
    .build()
    .map_err(|e| format!("popup build failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub(crate) fn hide_pet_popup(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("pet-popup") {
        w.hide().map_err(|e| format!("popup hide failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn move_pet_window(app_handle: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("pet") {
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x as i32, y as i32,
            )))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("pet window not found".to_string())
}

#[tauri::command]
pub(crate) fn get_pet_window_position(
    app_handle: tauri::AppHandle,
) -> Result<Option<(f64, f64)>, String> {
    if let Some(window) = app_handle.get_webview_window("pet") {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        return Ok(Some((pos.x as f64, pos.y as f64)));
    }
    Ok(None)
}

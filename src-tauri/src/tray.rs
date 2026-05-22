//! 트레이 상주 셸 (Phase 13). 메뉴바/트레이 아이콘 + 메뉴(보기/숨기기/종료) + 좌클릭 토글.
//!
//! 닫기 = 트레이로 hide(quit 아님)는 lib.rs의 `on_window_event(CloseRequested)`에서 처리한다.
//! 실제 종료는 트레이 "종료"에서 `app.exit(0)`로만 일어난다. 전역 핫키 토글(shortcut.rs)은 그대로.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// 메인 창 토글(보임↔숨김). 좌클릭/핫키 공통 동작.
fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/// 트레이 아이콘 + 메뉴를 만든다. setup에서 한 번 호출.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "tray_show", "보기", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "tray_hide", "숨기기", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "tray_quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &hide_i, &sep, &quit_i])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("wr-tray")
        .icon(icon)
        .tooltip("Work Radar")
        .menu(&menu)
        // 좌클릭은 메뉴를 열지 않고 창 토글에 쓴다(on_tray_icon_event).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main(app),
            "tray_hide" => hide_main(app),
            // 트레이 "종료"만이 실제 프로세스 종료 경로(닫기는 hide).
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

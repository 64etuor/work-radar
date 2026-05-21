//! 전역 핫키 → 캡처/루트 창 토글 (Raycast UX). 핫키 처리는 Rust에 둔다.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 기본 토글 핫키: Alt(Option) + Space.
fn toggle_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// 메인 창을 보이거나 숨긴다 (토글).
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

/// 전역 핫키를 등록한다. 누를 때마다 메인 창을 토글.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let shortcut = toggle_shortcut();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })?;
    Ok(())
}

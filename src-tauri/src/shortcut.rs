//! 전역 핫키 → 캡처/루트 창 토글 (Raycast UX). 핫키 처리는 Rust에 둔다.
//!
//! Phase 18: 핫키를 사용자가 편집·영속(app_config)·런타임 재등록할 수 있다. 파싱은
//! "Mod+Mod+Key" 형태 문자열(예: "Ctrl+Space", "Cmd+Shift+K")을 받아 검증한다.
//! 재등록은 bounded — 옛 핫키 unregister → 새 핫키 register, 충돌/무효 시 graceful Err(#5 정신).

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 기본 토글 핫키 문자열: Ctrl + Space. (app_config 미설정 시 폴백.)
pub const DEFAULT_GLOBAL_HOTKEY: &str = "Ctrl+Space";

/// 핫키 문자열을 `Shortcut`으로 파싱한다. "Mod+...+Key" — 최소 1 modifier + 정확히 1 key.
/// 허용 modifier: Ctrl/Control, Alt/Option, Shift, Cmd/Super/Meta/Win.
/// 실패 시 사람 읽을 수 있는 Err(문자열) — 검증/저장 거부에 쓴다.
pub fn parse_shortcut(spec: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = spec
        .split('+')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("핫키는 최소 1개 modifier + 1개 키여야 합니다 (예: Ctrl+Space)".into());
    }

    let mut mods = Modifiers::empty();
    let (key_part, mod_parts) = parts.split_last().unwrap();
    for m in mod_parts {
        match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "cmd" | "command" | "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            other => return Err(format!("알 수 없는 modifier: {other}")),
        }
    }
    if mods.is_empty() {
        return Err("최소 1개 modifier가 필요합니다".into());
    }

    let code = parse_code(key_part)?;
    Ok(Shortcut::new(Some(mods), code))
}

/// 키 이름 → `Code`. 자주 쓰는 키만 화이트리스트(데스크톱 핫키 norm) — 미지원 키는 명시 Err.
fn parse_code(key: &str) -> Result<Code, String> {
    let k = key.to_ascii_lowercase();
    let code = match k.as_str() {
        "space" => Code::Space,
        "enter" | "return" => Code::Enter,
        "tab" => Code::Tab,
        "escape" | "esc" => Code::Escape,
        "backslash" => Code::Backslash,
        "slash" => Code::Slash,
        "period" | "." => Code::Period,
        "comma" | "," => Code::Comma,
        "semicolon" | ";" => Code::Semicolon,
        "backquote" | "`" => Code::Backquote,
        "a" => Code::KeyA,
        "b" => Code::KeyB,
        "c" => Code::KeyC,
        "d" => Code::KeyD,
        "e" => Code::KeyE,
        "f" => Code::KeyF,
        "g" => Code::KeyG,
        "h" => Code::KeyH,
        "i" => Code::KeyI,
        "j" => Code::KeyJ,
        "k" => Code::KeyK,
        "l" => Code::KeyL,
        "m" => Code::KeyM,
        "n" => Code::KeyN,
        "o" => Code::KeyO,
        "p" => Code::KeyP,
        "q" => Code::KeyQ,
        "r" => Code::KeyR,
        "s" => Code::KeyS,
        "t" => Code::KeyT,
        "u" => Code::KeyU,
        "v" => Code::KeyV,
        "w" => Code::KeyW,
        "x" => Code::KeyX,
        "y" => Code::KeyY,
        "z" => Code::KeyZ,
        "0" => Code::Digit0,
        "1" => Code::Digit1,
        "2" => Code::Digit2,
        "3" => Code::Digit3,
        "4" => Code::Digit4,
        "5" => Code::Digit5,
        "6" => Code::Digit6,
        "7" => Code::Digit7,
        "8" => Code::Digit8,
        "9" => Code::Digit9,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        other => return Err(format!("지원하지 않는 키: {other}")),
    };
    Ok(code)
}

/// 메인 창을 보이거나 숨긴다 (토글).
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

/// 주어진 핫키 문자열을 등록한다. 누를 때마다 메인 창을 토글. 파싱/등록 실패는 Err로 노출.
pub fn register_spec<R: Runtime>(app: &AppHandle<R>, spec: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(spec)?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
        .map_err(|e| e.to_string())
}

/// 기본 핫키로 등록(startup). 저장된 값이 있으면 그것으로, 없으면 DEFAULT로 폴백.
/// startup에서만 호출 — 실패해도 앱 코어는 동작(graceful degrade)하도록 호출부가 처리.
pub fn register<R: Runtime>(app: &AppHandle<R>, spec: &str) -> Result<(), String> {
    register_spec(app, spec)
}

/// 핫키 재등록: 옛 핫키 unregister → 새 핫키 register. 새 핫키 등록 실패 시 옛 핫키 복원 시도.
/// bounded(2회 등록 시도 한도) — 무한 retry 없음(#5 정신).
pub fn reregister<R: Runtime>(
    app: &AppHandle<R>,
    old_spec: &str,
    new_spec: &str,
) -> Result<(), String> {
    // 새 핫키부터 검증(저장 거부 빠르게).
    let _ = parse_shortcut(new_spec)?;

    if let Ok(old) = parse_shortcut(old_spec) {
        let _ = app.global_shortcut().unregister(old);
    }

    match register_spec(app, new_spec) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 새 핫키 등록 실패(충돌 등) → 옛 핫키 복원 시도(graceful), 사용자에게 실패 노출.
            let _ = register_spec(app, old_spec);
            Err(format!("핫키 등록 실패(이전 핫키 유지): {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_hotkey() {
        assert!(parse_shortcut(DEFAULT_GLOBAL_HOTKEY).is_ok());
    }

    #[test]
    fn parses_multi_modifier() {
        assert!(parse_shortcut("Cmd+Shift+K").is_ok());
        assert!(parse_shortcut("Ctrl+Alt+1").is_ok());
    }

    #[test]
    fn rejects_no_modifier() {
        assert!(parse_shortcut("Space").is_err());
        assert!(parse_shortcut("K").is_err());
    }

    #[test]
    fn rejects_unknown_key_or_modifier() {
        assert!(parse_shortcut("Ctrl+Bogus").is_err());
        assert!(parse_shortcut("Hyper+Space").is_err());
    }

    #[test]
    fn trims_and_is_case_insensitive() {
        assert!(parse_shortcut(" ctrl + space ").is_ok());
        assert!(parse_shortcut("CMD+k").is_ok());
    }
}

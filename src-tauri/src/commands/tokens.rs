use std::path::Path;
use std::time::Duration;

use tauri::State;
use tokio::process::Command;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{CliToolStatus, PingResult, TokenKind, TokenStatus};
use crate::{api, keychain};

/// CLI 보조 서브프로세스 호출 상한 (무한 대기 금지 — INVARIANT #5, agent.rs AUX_TIMEOUT 선례).
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

// ── 토큰 (keychain 경유 — 토큰 본문은 절대 반환하지 않는다, INVARIANT) ──────────

/// project의 keychain 분리 키. 토큰 커맨드들이 공유한다.
pub(crate) async fn project_credential_ref(db: &Db, project_id: &str) -> Result<String, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT credential_ref FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.map(|r| r.0)
        .ok_or_else(|| "project not found".to_string())
}

/// 토큰 저장. 토큰은 IPC 인자로만 들어와 즉시 keychain으로 가고, 반환되지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn set_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
    token: String,
) -> Result<(), AppError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::validation(
            "tokens.empty_token",
            "토큰이 비었습니다",
        ));
    }
    // 저장 전 라이브 검증 — 잘못된/만료/권한 없는 토큰을 keychain에 넣지 않는다(import_notion_token 선례).
    // OAuth blob 종류(GoogleCalendar/Gmail/HermesBridge)는 단순 ping 대상이 아니라 검증 생략(별도 연결 흐름).
    match kind {
        TokenKind::Notion => {
            let ping = api::ping_notion(token).await;
            if !ping.ok {
                return Err(AppError::terminal(
                    "tokens.notion_verify_failed",
                    format!("Notion 토큰 검증 실패: {}", ping.detail),
                ));
            }
        }
        TokenKind::Github => {
            let ping = api::ping_github(token).await;
            if !ping.ok {
                return Err(AppError::terminal(
                    "tokens.github_verify_failed",
                    format!("GitHub 토큰 검증 실패: {}", ping.detail),
                ));
            }
        }
        TokenKind::GoogleCalendar | TokenKind::Gmail | TokenKind::HermesBridge => {}
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    Ok(keychain::set_token(&cref, kind, token)?)
}

/// 토큰 삭제(클리어).
#[tauri::command]
#[specta::specta]
pub async fn delete_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<(), AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    Ok(keychain::delete_token(&cref, kind)?)
}

/// 토큰 존재 여부만 (본문 미노출). UI 마스킹 표시용.
#[tauri::command]
#[specta::specta]
pub async fn project_token_status(
    db: State<'_, Db>,
    project_id: String,
) -> Result<TokenStatus, AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    Ok(TokenStatus {
        has_notion: keychain::has_token(&cref, TokenKind::Notion)?,
        has_github: keychain::has_token(&cref, TokenKind::Github)?,
    })
}

/// 토큰으로 외부 API ping(read-only). 토큰은 keychain에서 읽어 Rust 안에서만 쓰인다.
#[tauri::command]
#[specta::specta]
pub async fn ping_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<PingResult, AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    let token = keychain::get_token(&cref, kind)?;
    let Some(token) = token else {
        return Ok(PingResult {
            ok: false,
            detail: "토큰 없음".into(),
        });
    };
    Ok(match kind {
        TokenKind::Notion => api::ping_notion(&token).await,
        TokenKind::Github => api::ping_github(&token).await,
        // GoogleCalendar는 OAuth blob이라 단순 ping 대상이 아님 — 연결은 google_calendar_status로.
        TokenKind::GoogleCalendar => PingResult {
            ok: false,
            detail: "Google Calendar는 '연결' 흐름을 사용하세요".into(),
        },
        // Gmail도 OAuth blob이라 단순 ping 대상이 아님 — 연결은 gmail 연결 흐름으로(US-006).
        TokenKind::Gmail => PingResult {
            ok: false,
            detail: "Gmail은 '연결' 흐름을 사용하세요".into(),
        },
        // HermesBridge는 앱 레벨 단일 브리지(project별 ping 대상 아님) — 상태는 hermes_bridge_status로.
        TokenKind::HermesBridge => PingResult {
            ok: false,
            detail: "Hermes 브리지는 별도 상태/연결 흐름을 사용하세요".into(),
        },
    })
}

// ── CLI 토큰 import (auth 통일, Phase 14) ──────────────────────────────────────
//
// INVARIANT: 토큰 본문은 keychain으로만 간다 — gh/ntn에서 읽은 토큰도 IPC 반환·DB·렌더러에
// 절대 노출하지 않는다. 모든 서브프로세스 호출은 bounded(CLI_TIMEOUT) — 무한 대기 금지(#5).

/// `~`를 home으로 확장(알려진 경로 후보의 `~/.local/bin` 처리).
fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

/// PATH(또는 알려진 Homebrew/local 경로)에서 CLI 바이너리를 찾는다. GUI 앱은 launchd PATH가
/// 셸과 달라 `gh`/`ntn`이 PATH에 없을 수 있으므로 알려진 경로를 함께 시도한다(codex 선례).
/// 반환값은 항상 spawn 가능한 형태(절대 경로 또는 PATH 해석용 bare 이름).
fn resolve_cli_bin(name: &str, known: &[&str]) -> String {
    for c in known {
        let expanded = expand_home(c);
        if Path::new(&expanded).is_file() {
            return expanded;
        }
    }
    // bare 이름은 PATH 해석을 서브프로세스에 맡긴다(spawn 실패는 호출부에서 미설치로 처리).
    name.to_string()
}

/// 알려진 `gh` 후보 경로 (PATH 미해석 GUI 컨텍스트 대비).
fn gh_bin() -> String {
    resolve_cli_bin("gh", &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"])
}

/// 알려진 `ntn` 후보 경로.
fn ntn_bin() -> String {
    resolve_cli_bin(
        "ntn",
        &[
            "/opt/homebrew/bin/ntn",
            "/usr/local/bin/ntn",
            "~/.local/bin/ntn",
        ],
    )
}

/// bounded 서브프로세스 실행 → (success, stdout-trimmed). 타임아웃/spawn 실패는 (false, "").
async fn run_capture(bin: &str, args: &[&str]) -> (bool, String) {
    let fut = Command::new(bin).args(args).output();
    match tokio::time::timeout(CLI_TIMEOUT, fut).await {
        Ok(Ok(out)) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        ),
        _ => (false, String::new()),
    }
}

/// gh CLI 가용성 + 로그인 상태 (graceful degrade 판정용). 토큰 본문 미포함.
#[tauri::command]
#[specta::specta]
pub async fn gh_cli_status() -> Result<CliToolStatus, AppError> {
    let bin = gh_bin();
    // 설치 확인(--version). spawn 실패면 미설치로 간주.
    let (ver_ok, _) = run_capture(&bin, &["--version"]).await;
    if !ver_ok {
        return Ok(CliToolStatus {
            installed: false,
            logged_in: false,
            detail: "gh CLI 미설치 — 수동 붙여넣기를 사용하세요.".into(),
        });
    }
    let (auth_ok, _) = run_capture(&bin, &["auth", "status"]).await;
    Ok(CliToolStatus {
        installed: true,
        logged_in: auth_ok,
        detail: if auth_ok {
            "gh 로그인됨 — '가져오기'로 토큰을 import할 수 있습니다.".into()
        } else {
            "gh 설치됨 / 미로그인 — 'gh 로그인'을 먼저 진행하세요.".into()
        },
    })
}

/// `gh auth token` → keychain(TokenKind::Github). 토큰 본문은 stdout→keychain으로만 흐르고
/// IPC로 반환되지 않는다(INVARIANT). 미설치/미로그인/빈 토큰은 Err로 graceful 노출.
#[tauri::command]
#[specta::specta]
pub async fn import_github_token(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let bin = gh_bin();
    let (ok, token) = run_capture(&bin, &["auth", "token"]).await;
    if !ok || token.is_empty() {
        return Err(AppError::terminal(
            "tokens.gh_import_failed",
            "gh 토큰을 가져오지 못했습니다 — 'gh 로그인'을 먼저 진행하세요.",
        ));
    }
    // 저장 전 라이브 검증(import_notion_token 선례 — 그쪽은 ping하는데 gh import만 빠져 있었다).
    // 만료/무효 토큰을 keychain에 넣지 않는다.
    let ping = api::ping_github(&token).await;
    if !ping.ok {
        return Err(AppError::terminal(
            "tokens.github_verify_failed",
            format!("GitHub 토큰 검증 실패: {}", ping.detail),
        ));
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    Ok(keychain::set_token(&cref, TokenKind::Github, &token)?)
    // token은 여기서 drop — 어디에도 보관/반환되지 않는다.
}

/// `gh auth login --web` 런처(미로그인 시 인앱 버튼). 브라우저 동의 후 사용자가 '가져오기'를
/// 다시 누른다. 대화식 흐름이라 완료를 기다리지 않고 spawn만 한다(bounded: 즉시 반환).
#[tauri::command]
#[specta::specta]
pub async fn gh_auth_login_web() -> Result<(), AppError> {
    let bin = gh_bin();
    Command::new(&bin)
        .args(["auth", "login", "--web"])
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            AppError::terminal("tokens.gh_login_spawn", format!("gh 로그인 실행 실패: {e}"))
        })?;
    Ok(())
}

/// ntn CLI 가용성 + 로그인(토큰 import 가능) 상태. ntn은 토큰을 file-auth 위치
/// (`~/.config/notion/api_key`)에 저장하므로 그 파일 존재로 import 가능 여부를 판정한다.
/// (OS keychain 모드면 파일이 없을 수 있음 → 그 경우 붙여넣기 fallback.) 토큰 본문 미포함.
#[tauri::command]
#[specta::specta]
pub async fn ntn_cli_status() -> Result<CliToolStatus, AppError> {
    let bin = ntn_bin();
    let (ver_ok, _) = run_capture(&bin, &["--version"]).await;
    if !ver_ok {
        return Ok(CliToolStatus {
            installed: false,
            logged_in: false,
            detail: "ntn CLI 미설치 — 수동 붙여넣기를 사용하세요.".into(),
        });
    }
    let importable = ntn_token_from_file().is_some();
    Ok(CliToolStatus {
        installed: true,
        logged_in: importable,
        detail: if importable {
            "ntn 로그인됨 — '가져오기'로 토큰을 import할 수 있습니다.".into()
        } else {
            "ntn 설치됨 / 토큰 파일 없음 — 'ntn 로그인' 후 다시 시도하거나 붙여넣기를 사용하세요."
                .into()
        },
    })
}

/// ntn file-auth 위치에서 Notion 토큰을 읽는다(`~/.config/notion/api_key`). ntn은 비대화식
/// 토큰 emit 서브커맨드가 없어 file-auth 경로를 import 메커니즘으로 쓴다(Phase 14 §14 결정).
/// 토큰 본문은 여기서만 잠시 다뤄지고 호출부에서 즉시 keychain으로 간다.
fn ntn_token_from_file() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = Path::new(&home).join(".config/notion/api_key");
    let raw = std::fs::read_to_string(path).ok()?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// ntn file-auth 토큰 → 라이브 검증(ping) → keychain(TokenKind::Notion). 토큰 본문은 절대
/// IPC로 반환되지 않는다(INVARIANT). 파일 없음/검증 실패는 Err로 graceful 노출(붙여넣기 fallback 안내).
#[tauri::command]
#[specta::specta]
pub async fn import_notion_token(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let token = ntn_token_from_file().ok_or_else(|| {
        AppError::not_found(
            "tokens.ntn_file_missing",
            "ntn 토큰 파일을 찾지 못했습니다 — 'ntn 로그인' 후 다시 시도하거나 붙여넣기를 사용하세요.",
        )
    })?;
    // 저장 전 라이브 검증(잘못된/만료 토큰을 keychain에 넣지 않음).
    let ping = api::ping_notion(&token).await;
    if !ping.ok {
        return Err(AppError::terminal(
            "tokens.ntn_verify_failed",
            format!("ntn 토큰 검증 실패: {}", ping.detail),
        ));
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("tokens.project_not_found", e))?;
    Ok(keychain::set_token(&cref, TokenKind::Notion, &token)?)
    // token은 여기서 drop — 어디에도 보관/반환되지 않는다.
}

/// `ntn login` 런처(미로그인 시 인앱 버튼). 대화식이라 완료를 기다리지 않고 spawn만 한다.
#[tauri::command]
#[specta::specta]
pub async fn ntn_login() -> Result<(), AppError> {
    let bin = ntn_bin();
    Command::new(&bin)
        .arg("login")
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            AppError::terminal(
                "tokens.ntn_login_spawn",
                format!("ntn 로그인 실행 실패: {e}"),
            )
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_home_resolves_tilde() {
        let home = std::env::var("HOME").expect("HOME set in test env");
        assert_eq!(
            expand_home("~/.local/bin/ntn"),
            format!("{home}/.local/bin/ntn"),
        );
    }

    #[test]
    fn expand_home_passes_through_absolute() {
        assert_eq!(expand_home("/opt/homebrew/bin/gh"), "/opt/homebrew/bin/gh");
        assert_eq!(expand_home("gh"), "gh");
    }

    #[test]
    fn resolve_cli_bin_falls_back_to_bare_name() {
        // 존재하지 않는 후보만 주면 bare 이름으로 떨어진다(PATH 해석을 spawn에 위임).
        assert_eq!(
            resolve_cli_bin("gh", &["/nonexistent/path/gh"]),
            "gh".to_string(),
        );
    }
}

//! Work Radar — Tauri 2 백엔드 진입점.
//!
//! 3-Rail 모델 (INVARIANT, docs/architecture.md):
//!   결정 레일 (사람만)     : Eisenhower 분류 / 승격 여부      ← 자동화 접근 금지
//!   제안 레일 (Codex→사람) : enrich / draft → Proposal → Acceptance
//!   실행 레일 (사람→Codex) : worktree 구현 → draft PR → 사람 검수 → Acceptance
//!
//! 모든 외부 변경(Notion/GitHub)은 Acceptance 게이트를 거친다. 토큰은 keychain에만.

mod agent;
mod api;
mod calendar;
mod commands;
mod db;
mod git;
mod github;
mod jobs;
mod keychain;
mod models;
mod notion;
mod scheduler;
mod shortcut;
mod tray;

use tauri::{Manager, WindowEvent};
use tauri_specta::{collect_commands, Builder as SpectaBuilder};

/// specta + tauri command 레지스트리. run()과 바인딩 export 테스트가 공유한다.
pub fn tauri_specta_builder() -> SpectaBuilder<tauri::Wry> {
    SpectaBuilder::<tauri::Wry>::new().commands(collect_commands![
        commands::list_projects,
        // Projects / Repos / 토큰 (Phase 2).
        commands::create_project,
        commands::list_repos,
        commands::create_repo,
        commands::set_project_token,
        commands::delete_project_token,
        commands::project_token_status,
        commands::ping_project_token,
        // CLI 토큰 import (auth 통일, Phase 14) — 토큰은 keychain으로만, IPC 미반환.
        commands::gh_cli_status,
        commands::import_github_token,
        commands::gh_auth_login_web,
        commands::ntn_cli_status,
        commands::import_notion_token,
        commands::ntn_login,
        // projectId 태깅 / reconcile.
        commands::reconcile_signal_projects,
        commands::set_signal_project,
        // Signals — 캡처/조회/분류(사람 결정 레일).
        commands::create_signal,
        commands::list_signals,
        commands::classify_signal,
        commands::set_signal_status,
        commands::snooze_signal,
        commands::search_signals,
        // 브레인덤프 편집/하드 삭제 (Phase 15 #5).
        commands::update_signal_title,
        commands::delete_signal,
        // Today 레일 (로컬 승격).
        commands::promote_today,
        commands::unpromote_today,
        commands::toggle_today_done,
        commands::reorder_today,
        commands::list_today,
        // Today 운영 뷰 + Work Debt (Phase 11a).
        commands::today_overview,
        // Weekly review (Phase 11c).
        commands::weekly_review,
        // 회고 + 보관함 (Phase 17, 로컬 read + 사람 태깅).
        commands::list_completed,
        commands::set_signal_impact,
        commands::set_signal_regret,
        commands::list_archived_snoozed,
        commands::restore_signal,
        // 외부 승격 draft (Acceptance 게이트) + Notion write 레일 (Phase 3).
        commands::create_promotion_draft,
        commands::promote_to_notion,
        commands::flush_promotions,
        commands::list_promotions,
        // Routines.
        commands::create_routine,
        commands::list_today_routines,
        commands::toggle_routine_check,
        // PR Radar (read 레일, Phase 4).
        commands::refresh_pr_radar,
        commands::set_pr_self_check,
        // Worktree & Branch Diff (read-only, Phase 5).
        commands::list_worktrees,
        commands::list_worktree_branches,
        commands::worktree_diff_files,
        commands::worktree_file_diff,
        // 안전 dev rebase + 브랜치/워크트리 정리 (Phase 12c/12d).
        commands::rebase_worktree_onto,
        commands::list_cleanup_candidates,
        commands::delete_cleanup_candidates,
        // Agent 스파인 (잡 큐 + bounds + kill, Phase 7).
        commands::codex_status,
        commands::trigger_echo_job,
        commands::trigger_codex_job,
        commands::list_agent_runs,
        commands::kill_agent_run,
        commands::read_agent_log,
        // PR self-check 자동 초안 (suggestion 레일 + Acceptance 게이트, Phase 8).
        commands::trigger_pr_selfcheck,
        commands::pr_proposal,
        commands::accept_proposal,
        commands::reject_proposal,
        // 추가 suggestion 자동화 (enrich / CI triage, Phase 9).
        commands::trigger_enrich,
        commands::enrich_proposal,
        commands::accept_enrich,
        commands::set_signal_area,
        // 미분류 전체 배치 enrich (단일 잡, 부분 실패 격리, Phase 15 #4).
        commands::trigger_enrich_all,
        commands::batch_enrich_proposal,
        commands::accept_enrich_all,
        commands::trigger_ci_triage,
        commands::triage_proposal,
        commands::accept_triage,
        // Google Calendar OAuth 연결 (read 레일, Phase 10a).
        commands::set_google_oauth_client,
        commands::start_google_oauth,
        commands::google_calendar_status,
        commands::disconnect_google,
        commands::ping_google_calendar,
        // Google Calendar 캘린더 선택 + 이벤트 (read 레일, Phase 10b).
        commands::list_google_calendars,
        commands::set_selected_calendars,
        commands::fetch_calendar_events,
        // Google Calendar 이벤트 생성 (write 레일, Phase 19).
        commands::list_selected_calendars,
        commands::create_calendar_event,
        // 트레이 상주 스파인 + 알림 스케줄러 (Phase 13).
        commands::notification_permission,
        commands::request_notification_permission,
        commands::schedule_test_notification,
    ])
}

/// 생성된 TS 바인딩이 쓰이는 프런트 소스 경로. (수기 타입 중복 금지 — INVARIANT)
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

/// Rust 타입 → TS 바인딩 export. dev 런타임과 `cargo test` 둘 다에서 호출된다.
#[cfg(any(debug_assertions, test))]
fn export_bindings(builder: &SpectaBuilder<tauri::Wry>) {
    builder
        .export(specta_typescript::Typescript::default(), BINDINGS_PATH)
        .expect("failed to export typescript bindings");
}

/// 스케줄러가 발사를 위임하는 app 핸들 기반 Notifier. tauri-plugin-notification으로 네이티브
/// 알림을 띄운다. 권한 없음/미지원이면 Err를 돌려주고 스케줄러가 로그만 남긴다(graceful degrade).
struct AppNotifier(tauri::AppHandle);

impl scheduler::Notifier for AppNotifier {
    fn notify(&self, n: &scheduler::DueNotification) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.0
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = tauri_specta_builder();

    // 디버그 빌드에서만 TS 바인딩을 프런트 소스로 export.
    #[cfg(debug_assertions)]
    export_bindings(&specta_builder);

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // "Notion에서 열기" 딥링크 — 생성된 페이지 URL을 외부(브라우저/Notion 앱)에서 연다.
        .plugin(tauri_plugin_opener::init())
        // 백그라운드 스케줄러가 발사하는 네이티브 알림 (Phase 13).
        .plugin(tauri_plugin_notification::init())
        // 폴더 picker (Phase 14): repo local_path 등 경로 입력을 OS 다이얼로그로.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(specta_builder.invoke_handler())
        // 닫기 = 트레이로 hide(quit 아님). 실제 종료는 트레이 "종료"의 app.exit(0)에서만.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            // DB는 OS app-data 경로에 둔다. setup에서 동기적으로 초기화.
            let app_data = app.path().app_data_dir().expect("resolve app data dir");
            let pool = tauri::async_runtime::block_on(db::init_db(&app_data.join("work-radar.db")))
                .expect("failed to initialize database");
            app.manage(pool);

            // 잡 큐 매니저(Phase 7): codex 경로 해석(graceful degrade) + worktree/로그 디렉터리 +
            // 동시성 1. INVARIANT #5/#6은 jobs.rs/agent.rs에서 강제.
            let codex_bin = tauri::async_runtime::block_on(agent::resolve_codex_bin());
            app.manage(jobs::JobManager::new(
                codex_bin,
                app_data.join("worktrees"),
                app_data.join("logs"),
                1,
            ));

            // 전역 핫키(Ctrl+Space)로 캡처/루트 창 토글.
            shortcut::register(app.handle())?;

            // 트레이 상주 셸(Phase 13): 메뉴바 아이콘 + 메뉴(보기/숨기기/종료) + 좌클릭 토글.
            tray::create(app.handle())?;

            // 백그라운드 스케줄러 스파인(Phase 13): bounded tick으로 due 알림을 발사한다.
            // 알림 발사는 app 핸들 기반 Notifier로 추상화(scheduler.rs는 발사 메커니즘 무지).
            let sched_db: db::Db = app.state::<db::Db>().inner().clone();
            scheduler::spawn_loop(sched_db, AppNotifier(app.handle().clone()));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod bindings_export {
    /// `cargo test`가 src/bindings.ts를 생성한다. (프런트 빌드 전 바인딩 보장)
    #[test]
    fn export_typescript_bindings() {
        super::export_bindings(&super::tauri_specta_builder());
    }
}

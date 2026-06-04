//! Tauri IPC commands. specta가 이 시그니처에서 TS 바인딩을 생성한다.
//! INVARIANT: Notion/GitHub 등 외부 호출은 Rust에 둔다(토큰 렌더러 노출 금지).
//! INVARIANT #1: quadrant 변경은 오직 `classify_signal`(사람 결정)로만. 생성은 항상 unclassified.
//! INVARIANT #2: 외부 승격(notion/calendar)은 `create_promotion_draft`로 draft만 — 외부 무변경.
//!
//! 도메인별 서브모듈로 분할. lib.rs의 `collect_commands![commands::foo, …]` 경로는
//! 아래 `pub use <submod>::*;` 재export로 그대로 해석된다(시그니처/순서 불변).

pub mod shared;

/// 사람-게이트 증거 토큰(External Action Gate approve/reject type-wall).
pub mod approval_grant;

pub mod agent_run_store;
pub mod agents;
pub mod agents_config;
pub mod calendar;
pub mod calendar_sync;
pub mod cmux;
pub mod external_actions;
pub mod governance;
pub mod hermes;
pub mod hermes_agent;
pub mod hermes_panel;
pub mod inbox;
pub mod nav;
pub mod news;
pub mod notification_store;
pub mod notion;
pub mod pr_radar;
pub mod projects;
pub mod retro;
pub mod routines;
pub mod scheduler;
pub mod signal_store;
pub mod signals;
pub mod sprint;
pub mod timeline_notes;
pub mod today;
pub mod tokens;
pub mod worktree;

pub use agents::*;
pub use agents_config::*;
pub use calendar::*;
pub use calendar_sync::*;
pub use cmux::*;
pub use governance::*;
pub use hermes::*;
pub use hermes_panel::*;
pub use inbox::*;
pub use nav::*;
pub use news::*;
pub use notion::*;
pub use pr_radar::*;
pub use projects::*;
pub use retro::*;
pub use routines::*;
pub use scheduler::*;
pub use signals::*;
// skills 모듈은 크레이트 루트(`crate::skills`)로 이동했다(G1-PR1). 기존 `commands::skills::X`
// 경로(에이전트 모듈/agents_config의 plain fn·const import)가 유지되도록 alias 재export 한다.
// `#[tauri::command]` 매크로의 hidden 심볼은 glob/alias로 넘어가지 않으므로(E0433), 커맨드 등록은
// lib.rs에서 `skills::X`로 직접 가리킨다.
pub use crate::skills;
pub use sprint::*;
pub use timeline_notes::*;
pub use today::*;
pub use tokens::*;
pub use worktree::*;

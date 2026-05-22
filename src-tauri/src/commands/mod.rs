//! Tauri IPC commands. specta가 이 시그니처에서 TS 바인딩을 생성한다.
//! INVARIANT: Notion/GitHub 등 외부 호출은 Rust에 둔다(토큰 렌더러 노출 금지).
//! INVARIANT #1: quadrant 변경은 오직 `classify_signal`(사람 결정)로만. 생성은 항상 unclassified.
//! INVARIANT #2: 외부 승격(notion/calendar)은 `create_promotion_draft`로 draft만 — 외부 무변경.
//!
//! 도메인별 서브모듈로 분할. lib.rs의 `collect_commands![commands::foo, …]` 경로는
//! 아래 `pub use <submod>::*;` 재export로 그대로 해석된다(시그니처/순서 불변).

pub mod shared;

pub mod agents;
pub mod calendar;
pub mod hermes;
pub mod notion;
pub mod pr_radar;
pub mod projects;
pub mod retro;
pub mod routines;
pub mod scheduler;
pub mod signals;
pub mod today;
pub mod tokens;
pub mod worktree;

pub use agents::*;
pub use calendar::*;
pub use hermes::*;
pub use notion::*;
pub use pr_radar::*;
pub use projects::*;
pub use retro::*;
pub use routines::*;
pub use scheduler::*;
pub use signals::*;
pub use today::*;
pub use tokens::*;
pub use worktree::*;

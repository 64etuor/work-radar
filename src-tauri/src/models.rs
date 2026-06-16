//! 도메인 타입 facade. 실제 타입은 `models/*`에 도메인별로 나뉘고, 기존 `crate::models::*` import는 여기서 유지한다.
//! INVARIANT: 토큰 같은 비밀은 절대 이 타입들에 담기지 않는다 (keychain 참조만).
//! INVARIANT: `quadrant`(사람 결정) vs `suggested_quadrant`/`suggested_area`(파생 힌트) 분리.

mod agent;
mod audit;
mod automation;
mod bookkeeping;
mod calendar;
mod inbox;
mod pending_write;
mod pr_radar;
mod project;
mod promotion;
mod routines;
mod signals;
mod skills;
mod timeline_note;
mod today;
mod tokens;
mod worktree;

pub use agent::*;
pub use audit::*;
pub use automation::*;
pub use bookkeeping::*;
pub use calendar::*;
pub use inbox::*;
pub use pending_write::*;
pub use pr_radar::*;
pub use project::*;
pub use promotion::*;
pub use routines::*;
pub use signals::*;
pub use skills::*;
pub use timeline_note::*;
pub use today::*;
pub use tokens::*;
pub use worktree::*;

//! 스킬 공유 레지스트리 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
//! Claude/Codex/Openclaw 스킬(`~/.{claude,codex,agents,openclaw}/skills/*/SKILL.md`)을 한
//! 레지스트리에서 보기/편집/추가/토글한다(P0: 멀티루트 frontmatter 스캔, 읽기 전용).
//!
//! INVARIANT #1/#2 (구조적 보호):
//!  - 인앱 프롬프트 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡 트리거는 binding으로 활성 프롬프트를
//!    조회하지만(`resolve_prompt`), 그 잡은 여전히 `gated=true`로 spawn되어 awaiting_approval에서 멈추고
//!    accept 코드(execute_accept_*)는 suggested_*/proposal만 쓴다 — 스킬을 편집해도 자동 분류/자동 적용
//!    경로는 절대 생기지 않는다. 스킬은 결코 자동 실행/적용되지 않는다.
//!  - 레지스트리가 비어 있거나 행이 비활성이면 잡 lookup은 코드 상수로 **폴백**한다(기본 동작 불변).
//!
//! INVARIANT #7: 인앱 프롬프트는 로컬 SQLite SSOT. 외부 스킬은 디스크가 SSOT이고 표는 캐시하지 않는다
//! (매 스캔마다 ROOTS의 각 `*/SKILL.md`에서 frontmatter만 읽는다 — 콘텐츠 해싱 없음).
//!
//! 토큰/비밀은 다루지 않는다(프롬프트 템플릿은 비밀 아님). 외부 스킬 파일을 *실행*하지 않는다 — 읽기/
//! (선택) 사용자 명시 편집만. 스캔 로그는 provider+count만 — 절대 경로/frontmatter 본문 금지(C7).
//!
//! ADR-0006 (풀 매니저 채택): P0는 멀티루트 frontmatter 스캔(claude/codex/openclaw)까지 — **읽기 전용·
//! 외부 dir 무쓰기**(viewer 절반). Phase G부터 중앙 라이브러리 SSOT + 외부 dir 설치/sync를 ADR-0006
//! 레일(사용자 발동·가역·audit / Rust+keychain+bounded)로 도입한다. **비실행 및 #1/#2(스킬 설치/sync ≠
//! 잡 자동실행)는 G에서도 불변.** 정본: docs/adr/0006-skills-registry-full-manager.md.
//!
//! G1-PR1(무행동변경): 2022줄 `commands/skills.rs`를 도메인 서브모듈(seed/scan/tags/registry)로 분할했다.
//! 로직/시그니처/IPC 표면 불변 — 순수 이동 + 모듈 간 호출에 필요한 만큼만 `pub(crate)` 가시성 확대.
//! 모델(`Skill` 등)은 옮기지 않고 `crate::models`에 그대로 둔다.

pub mod audit_log;
pub mod backup;
pub mod central_repo;
pub mod import;
pub mod installer;
pub mod registry;
pub mod remote;
pub mod scan;
pub mod seed;
pub mod source;
pub mod tags;
pub mod updater;

#[cfg(test)]
mod tests;

// 기존 호출부(lib.rs collect_commands!, 다른 모듈)가 경로 변경 없이 쓰도록 커맨드/헬퍼 re-export.
pub use registry::{create_skill, delete_skill, list_skills, update_skill};
pub use scan::{
    detect_skill_environments, get_skill_user_roots, read_external_skill, scan_external_skills,
    set_skill_user_roots, write_external_skill,
};
pub use seed::{resolve_prompt, seed_in_app_skills};
// 아래는 seed에서 `pub(crate)`라 외부로 re-export 불가(E0364) — 크레이트 내부용 alias만.
// `crate::commands::skills::X`(에이전트 모듈/agents_config) 경로가 `pub use crate::skills;` alias를
// 통해 이 심볼들로 해석된다.
pub use audit_log::list_skill_audit;
pub use backup::{backup_skill_library, list_skill_backups, restore_skill_library};
pub use import::{import_external_skill, remove_managed_skill};
pub use installer::install_skill_from_git;
pub(crate) use seed::{
    resolve_agent_prompt_runtime, BINDING_BATCH_ENRICH, BINDING_CI_TRIAGE, BINDING_PR_SELFCHECK,
    FAST_CODEX_MODEL,
};
pub use tags::set_skill_tags;
pub use updater::{
    apply_skill_update, check_skill_updates, get_skill_update_on_launch, list_skill_update_status,
    set_skill_auto_update, set_skill_update_on_launch,
};

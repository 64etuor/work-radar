---
adr-id: ADR-0006
status: accepted
date: 2026-05-30
decision-makers: [yangha.park]
tags: [skills, scope, rails, sync, network]
supersedes:
---

# 0006. Skills Registry as Full Manager: Central Library, External-Dir Sync, Network Install

## Context and Problem Statement

**Scope**: 스킬 레지스트리(`SkillsView` + `src-tauri/src/commands/skills.rs` + 신설 스킬 매니저
모듈). 외부 에이전트 스킬 디렉터리(`~/.{claude,codex,openclaw}/skills`)와의 상호작용.

스킬 레지스트리는 Phase 20 #21에서 **읽기 전용 뷰어 + 인앱 프롬프트 편집기**로 출발했다:
디스크 SSOT, 외부 dir 쓰기 없음, 네트워크 설치 없음, 중앙 레포 없음. 오픈소스
[skills-manager](https://github.com/xingkongliang/skills-manager)의 UX를 이식(`2026-05-29-skills-manager-migration.md`)하면서
그 도구의 **"매니저 절반"**(중앙 라이브러리 ↔ 외부 dir 심링크/설치, 양방향 sync, 마켓플레이스/git
설치, git 백업, auto-update)이 표면화됐고, 이는 기존 INVARIANT 여럿과 충돌한다.

결정 필요: work-radar 스킬 레지스트리를 **뷰어로 둘 것인가, 매니저로 확장할 것인가.**

## Decision Drivers

- 사용자는 여러 에이전트(claude/codex/openclaw) 스킬을 **실제로 관리**하는 단일 도구를 원한다 —
  단순 조회는 `ls`로 충분하다. skills-manager의 가치는 매니저 절반에 있다.
- 단, **codex 자동화의 안전(INVARIANT #1/#2)은 약화하지 않는다** — 스킬 *파일*을 관리하는 것과 그
  스킬로 잡을 *자동 실행*하는 것은 다른 층이다.
- 외부 dir에 대한 쓰기는 **사용자 발동 · 가역(reversible) · 감사(audit) 가능**해야 한다.
- 네트워크/시크릿 레일(Rust 경유, keychain, bounded retry, 로그에 PII/시크릿 금지)은 **유지**한다.

## Considered Options

- **Option A — 뷰어 유지(status quo).** 현 INVARIANT 그대로. 매니저 기능 전부 reject.
- **Option B — work-radar 소유 라이브러리(중간).** work-radar가 자기 소유 스토어에 fetch/설치하고
  사용자가 명시적으로 내보내기. 외부 dir 직접 쓰기·auto-update·프로젝트 sync는 제외.
- **Option C — 풀 매니저.** skills-manager 모델 전부: 중앙레포↔외부 dir 심링크/설치, 양방향 sync,
  마켓플레이스/git 설치, git 백업, auto-update.

## Decision Outcome

**Rule**: 스킬 레지스트리는 **풀 매니저**로 확장한다(Option C). work-radar는 중앙 관리 라이브러리를
유지하고 외부 에이전트 스킬 dir에 **쓰기(심링크/복사)** 할 수 있다 — 단 다음 레일 안에서만:

1. **외부 dir 쓰기는 사용자 발동 · 가역 · 감사 가능.** 설치/심링크/sync는 명시적 사용자 액션으로만
   일어나고, 되돌리기(uninstall = 원상복구)가 가능하며 `audit_log`에 기록한다. 스킬 *파일*만 다루며
   에이전트의 config/secret 파일은 건드리지 않는다.
2. **중앙 라이브러리가 _관리되는(managed)_ 스킬의 SSOT.** 발견된(discovered) 외부 스킬은 import 전까지
   여전히 디스크-SSOT(읽기 전용). import 시 중앙레포로 복사되고 그 시점부터 중앙레포가 SSOT.
3. **네트워크 설치(skills.sh/git) 허용 — 단 Rust 경유 + keychain + bounded retry(backoff+jitter+
   terminal failure 노출).** 토큰은 렌더러에 노출하지 않는다.
4. **auto-update 허용 — 단 opt-in + bounded(무한 poll 금지) + 절대 스킬/잡을 자동 실행하지 않는다.**
   업데이트는 파일 fetch까지이며, 적용 여부는 사용자에게 남긴다.

**개정되는 INVARIANT** (decision-rails.md 갱신 필요 — Consequences 참조):

- "외부 에이전트 디렉터리에 쓰기/심링크 금지" → **위 레일 1 하에서 허용.**
- "디스크 SSOT, 중앙레포 없음" → **레일 2로 개정**(중앙레포 = managed 스킬 SSOT, discovered는 디스크).
- "네트워크 스킬 설치 없음" → **레일 3 하에서 허용.**
- "스킬 auto-update 없음" → **레일 4 하에서 허용.**

**불변(개정하지 않음 — hard)**:

- **INVARIANT #1/#2**: 스킬/인앱 프롬프트는 codex 잡을 **자동 실행/적용하지 않는다.** 잡은 여전히
  `gated=true`로 spawn → awaiting_approval → accept 경로는 suggested/proposal만 쓴다. 스킬 파일을
  설치/동기화하는 것은 파일 I/O이지 잡 실행이 아니다. 이 경계가 무너지면 ADR 위반.
- 외부 토큰은 OS keychain(`keyring`, project별 분리). 로그에 PII/시크릿 금지.

Chosen option: **"Option C"**, 사용자가 멀티-에이전트 스킬을 실제 관리하길 원하고, 안전이 필요한
지점(잡 자동실행·시크릿)은 위 hard 불변으로 보존되기 때문.

### Consequences

- Good: claude/codex/openclaw 스킬을 한 곳에서 설치·동기화·백업·업데이트. skills-manager의 검증된
  매니저 로직(central_repo/sync_engine/installer/git_fetcher/skill_auto_updater)을 이식 가능.
- Bad: 표면적이 크게 늘고(외부 dir 쓰기·네트워크·git), 회귀/데이터손실 위험이 생긴다 → 가역성·감사·
  bounded 레일로 상쇄.
- **decision-rails.md / AGENTS.md INVARIANT 문구를 본 ADR에 맞춰 개정해야 한다**(follow-up).
- Phase G의 게이트가 풀린다(플랜 `2026-05-29-skills-manager-migration.md` Phase G1–G3로 재구성).

### Confirmation

- 가역성 테스트: install → uninstall이 외부 dir을 원상복구(심링크 제거, 사용자 파일 무손상).
- `audit_log` 항목: 모든 외부 dir 쓰기/sync에 대해 기록 존재.
- bounded retry 테스트: 네트워크 설치/auto-update가 backoff+jitter + terminal failure 노출, 무한 poll 없음.
- 잡 자동실행 가드 테스트(유지): 스킬 설치/동기화 후에도 잡은 gated → Acceptance 경로 불변(#1/#2).
- grep/리뷰어 체크리스트: 외부 dir 쓰기 경로가 사용자 액션에서만 도달, config/secret 파일 비대상.

### Anti-Patterns

- 스킬을 설치/동기화했다고 잡을 자동 실행/적용(#1/#2 위반 — 가장 중대).
- auto-update를 무한 poll/무제한 retry로 구현.
- 외부 dir에 토큰/시크릿 또는 config 파일 쓰기.
- 사용자 확인 없이 외부 스킬 덮어쓰기 / 비가역 삭제 / 감사 누락.
- 렌더러에 git/네트워크 토큰 노출.

## Pros and Cons of the Options

### Option A — 뷰어 유지

- Good: 가장 작고 안전, 현 레일 무변경.
- Bad: skills-manager의 핵심 가치(관리) 포기 — 사용자 요구 미충족.

### Option B — 소유 라이브러리(중간)

- Good: 외부 dir 무쓰기 유지하면서 설치/검색 일부 확보.
- Bad: 외부 dir에 적용하려면 결국 사용자가 수동 복사 — 멀티-에이전트 관리 UX가 반쪽.

### Option C — 풀 매니저 (채택)

- Good: 멀티-에이전트 설치/동기화/백업/업데이트 완결. 이식 가능한 검증된 로직.
- Bad: 표면적·위험 최대 → 가역성·감사·bounded·잡 자동실행 금지 레일로 통제.

## More Information

- Related: ADR-0001(거버넌스). decision-rails.md INVARIANT 개정 follow-up 필요.
- Implemented in: 플랜 `docs/plans/2026-05-29-skills-manager-migration.md` Phase G1–G3.
- Key files(이식 대상, skills-manager 대응): `core/central_repo`, `core/sync_engine`,
  `core/installer`, `core/git_fetcher`, `core/skill_auto_updater`, `core/git_backup`,
  `core/audit_log`, `core/tool_adapters`(심링크 설치), `commands/{sync,presets,projects,browse}`.

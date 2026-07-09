---
adr-id: ADR-0012
status: accepted
date: 2026-07-10
decision-makers: [yangha.park]
tags: [mcp, external-action-gate, decision-rails, calendar, least-privilege]
supersedes:
---

# 0012. MCP 로컬 write를 전 caller에 개방하고, 캘린더 read-only outbound를 허용한다

## Context and Problem Statement

**Scope**: `src-tauri/src/mcp/**`, `docs/areas/mcp-server-conventions.md`,
`docs/areas/decision-rails.md` (프런트/IPC 무변경).

`work-radar --mcp-stdio`가 노출하는 16개 툴은 도메인 커버리지가 비대칭이다. 가계부 read 5개만
열려 있고 캘린더는 write 전용, OKR·braindump·루틴·Today는 표면에 아예 없다. 외부 에이전트가
"오늘 일정 뭐야?"에 답하거나 "이거 메모해둬"를 수행할 수 없다.

표면을 넓히려면 두 가지 기존 규율과 정면으로 만난다.

1. **`require_hermes` 게이트.** 로컬 SQLite write(`wr_bookkeeping_save_receipt`,
   `wr_bookkeeping_mark_duplicate`)는 `WORK_RADAR_MCP_CALLER=hermes`일 때만 허용된다.
   braindump 캡처(`wr_create_signal`)를 같은 규칙으로 두면, Claude Code/Codex가
   `--mcp-stdio`를 직접 등록한 세션에서는 메모 하나 남길 수 없다 — MCP 표면을 넓히는 목적이
   상당 부분 무산된다.

2. **`mcp-server-conventions §7`의 "네트워크 없음(Phase 1)".** 캘린더 이벤트는 로컬 DB에
   저장되지 않는다(`calendar_events_cache()`는 앱 프로세스 내 60초 TTL in-memory 캐시).
   MCP 프로세스는 콜드 스타트라, 캘린더 read 툴은 필연적으로 실 Google API를 친다.
   (이 조항은 이미 사문화 상태다 — Hermes caller의 `wr_calendar_create_event`는 Google에
   POST한다.)

## Decision

### 1. 로컬 SQLite write는 모든 MCP caller에 개방한다

`require_hermes`와 그 호출부를 삭제한다. `McpCaller`는 **외부 서비스 write의 실행/제안 분기**를
위해서만 남는다.

근거: 모든 MCP 호스트는 자기 승인 UI를 갖는다 — Hermes는 ACP `session/request_permission`
카드, Claude Code/Codex는 호스트 자체의 tool-call 승인 프롬프트. `WORK_RADAR_MCP_CALLER`는
Work Radar가 Hermes 세션에 주입하는 env지만, 다른 호스트가 자기 config에 같은 env를 넣으면
그만이다. **실질 보안을 더하지 않으면서 정당한 사용을 막는 게이트**다.

경계는 유지된다:

- **외부 서비스 write**(GitHub/Notion/Calendar/Gmail): non-Hermes → `store::enqueue` proposal 큐.
  Hermes → permission card 이후 Rust connector 직접 실행. **이 분기는 변경하지 않는다.**
- `Acceptance::mint`의 `pub(in crate::external_actions)` 타입-월과 trybuild compile-fail 락은 그대로.
  mcp 모듈은 `store::{approve,reject}`·커넥터 `execute`를 여전히 import/호출하지 않는다.
- 로컬 write는 애초에 Acceptance 게이트 대상이 아니다 — INVARIANT #2가 명시한다:
  "Today 승격은 로컬 SQLite 액션이라 Acceptance 불요(외부 변경 아님)."

### 2. MCP write 표면은 캡처 레인 + 관측 기록으로 한정한다 (INVARIANT #1 기계화)

개방의 대가로, **어떤 로컬 write를 노출하는지**를 결정 레일 기준으로 못 박는다.

노출: `wr_create_signal`(SQL이 `quadrant='unclassified'`를 하드코딩, `dedup_key`로 upsert) ·
`wr_upsert_timeline_note` · `wr_toggle_routine_check` · `wr_okr_upsert_check_in`.

차단(표면에 존재 금지): `classify_signal` · `promote_today` · `toggle_today_done` ·
`set_signal_status` · `snooze_signal` · `delete_signal` · objective/key-result CRUD ·
`update_key_result` · `set_key_result_routine`.

가르는 기준: **사람이 보는 판단 산출물로 자동으로 흘러드는가.** KR `current_value`는 progress를
구동하고 progress는 보드 OKR 배지로 승격되므로 차단한다. check-in `confidence`는 어떤 파생
값도 구동하지 않는 순수 주간 로그이며 `(kr, week_start)` upsert라 멱등·가역이므로 허용한다.

이 denylist는 문서 규칙이 아니라 **라우터에 해당 이름이 없음을 단언하는 테스트**로 강제한다.

### 3. 캘린더 read-only outbound를 허용한다

`§7 "네트워크 없음"`을 **"caller가 목적지를 정하는 네트워크 없음"**으로 개정한다.

허용: 이미 연결된 provider(Google Calendar)로의 read-only 조회. 도메인·경로는 코드 상수이고
caller 입력은 URL에 닿지 않는다. 토큰은 `project_id` → DB `credential_ref` → keychain으로만
해석한다. 윈도우 상한 62일. bounded retry(backoff+jitter), terminal failure는 rmcp 에러로 surface.
응답 본문은 로그에 남기지 않는다(코드+크기만).

여전히 금지: `fetch_url` · `import_from_url` · `sync_remote` · webhook · OAuth proxy · 임의 API 호출.
caller가 host/path/query/URL을 지정하는 필드는 스키마에 **존재하지 않는다**.

DTO는 표시 전용 필드를 제외한 최소 집합이다: `id, calendar_id, calendar_summary, title, start,
end, all_day, project_id`. 제외: `location`, `url`(htmlLink), `project_color`, `project_text_color`,
`recurring_event_id` — §7 최소권한(다른 MCP 서버로의 유출 표면 최소화).

## Consequences

**좋아지는 것**

- 어떤 MCP 호스트에서도 braindump 캡처·일정 조회·OKR 조회가 된다. 표면이 도메인별로 대칭이 된다.
- 결정 레일이 문서 규칙에서 **테스트로 강제되는 denylist**로 승격된다 — "실수로 `classify_signal`
  추가"가 CI에서 잡힌다.
- caller 게이팅 규칙이 하나로 단순해진다: **로컬 = 개방, 외부 서비스 = Hermes 아니면 proposal.**

**나빠지는 것 / 잔여 위험**

- **로컬 write blast radius.** 악성/오작동 MCP 호스트가 신호를 대량 생성할 수 있다. `dedup_key`가
  동일 제목 반복은 흡수하지만 서로 다른 제목은 못 막는다. 수용 근거: 로컬·가역·감사 가능하고,
  **삭제 툴이 표면에 없어 파괴적이지 않다.**
- **캘린더 read 지연·rate limit.** MCP 프로세스는 캐시가 콜드라 첫 호출이 Google 라운드트립이다.
  같은 프로세스 내 반복 호출은 `calendar_events_cache()`(`OnceLock` static)가 60초 흡수한다.
  완전한 해소는 로컬 캐시 테이블 트랙(별도 ADR).
- `§7`이 "네트워크 없음"이라는 단순 명제를 잃는다. 대신 "caller가 목적지를 못 정한다"는 더 정확한
  명제로 교체된다 — 검토 시 이 구분을 놓치면 `fetch_url` 류가 슬금슬금 들어올 수 있다.

## Alternatives Considered

- **로컬 write도 Hermes 전용 유지.** read만 개방. → braindump 캡처가 Hermes에서만 되고, 다른
  호스트에서 MCP 표면의 절반이 죽는다. 게이트가 막는 실제 위협도 없다(env는 흉내 가능).
- **로컬 write를 proposal 큐로.** 캡처 하나 남기려고 GUI 승인 패널을 열어야 한다 — 실사용 불가.
- **캘린더 이벤트 로컬 캐시 테이블 신설.** 네트워크 없이 실 일정을 보여줄 수 있는 유일한 방법이나,
  마이그레이션 + write-through 싱크 + 무효화 설계가 붙어 이번 범위를 크게 넘는다. 비목표로 남기고
  후속 트랙으로 분리.
- **캘린더 read를 로컬 일정(루틴/Today/타임라인)으로 대체.** 네트워크를 피하지만 "구글 캘린더에
  박힌 미팅"이 안 보여 "오늘 일정" 질문에 반쪽만 답한다.

## References

- 설계 정본: `docs/superpowers/specs/2026-07-10-mcp-surface-expansion-design.md`
- `docs/areas/mcp-server-conventions.md` — §1 툴 표면, §7 네트워크·최소권한 (이 ADR로 개정)
- `docs/areas/decision-rails.md` — INVARIANT #1(결정 레일), #2(Acceptance 게이트), #3(dedup upsert)
- `docs/adr/0006-skills-registry-full-manager.md` — "사용자 발동 = 사람 결정" 선례

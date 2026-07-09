---
status: accepted
owner: repo-maintainers
last_reviewed: 2026-07-10
source_of_truth_scope: work-radar MCP 표면 확장(캘린더 read / OKR / braindump / 루틴·Today) 설계 — 툴 목록, caller 정책, DTO 정제, 모듈 경계
---

# MCP Surface Expansion — 캘린더 · OKR · Braindump · 루틴/Today

## 1. 문제

`work-radar --mcp-stdio`가 노출하는 16개 툴은 도메인 커버리지가 심하게 비대칭이다.

| 도메인              | 현재 read                                                | 현재 write                       |
| ------------------- | -------------------------------------------------------- | -------------------------------- |
| 승인 큐/프로젝트    | `list_pending_actions`, `action_status`, `list_projects` | `propose_noop`                   |
| 가계부              | 5개 (거래/리뷰큐/월요약/카테고리규칙/중복후보)           | `save_receipt`, `mark_duplicate` |
| 캘린더              | **없음**                                                 | `calendar_create_event`          |
| GitHub              | 없음                                                     | `github_comment`, `create_issue` |
| Notion              | 없음                                                     | `notion_create_page`             |
| Gmail               | 없음                                                     | `gmail_send`                     |
| OKR/Mission         | **없음**                                                 | **없음**                         |
| Braindump/신호      | **없음**                                                 | **없음**                         |
| 루틴·Today·타임라인 | **없음**                                                 | **없음**                         |

결과: 에이전트가 "오늘 일정 뭐야?"에 답할 수 없고, "이거 메모해둬"(braindump 캡처)를 수행할
수 없으며, OKR 진행 상황을 읽을 수 없다. 가계부 read 5개만 섬처럼 열려 있다.

## 2. 목표 / 비목표

**목표**

- 캘린더·OKR·braindump·루틴/Today를 MCP 표면에 대칭적으로 노출한다.
- 결정 레일(INVARIANT #1)을 **표면에서 기계적으로** 유지한다 — 에이전트는 _적어둘_ 수 있지만
  _정할_ 수 없다.
- 툴 추가 전에 `mcp/mod.rs`(2512줄)를 도메인 모듈로 분할해 god-file 재발을 막는다.

**비목표**

- 외부 서비스 write 계약 변경 (GitHub/Notion/Calendar/Gmail은 non-Hermes → proposal 그대로).
- 캘린더 이벤트 로컬 캐시 테이블 신설 (마이그레이션·싱크·무효화 설계는 별도 트랙).
- 가계부 cashflow / category_trend / trash / export 노출 (YAGNI — 차트 피딩용).

## 3. 결정 레일 경계 — 무엇을 노출하고 무엇을 막는가

INVARIANT #1은 "매트릭스 분류·승격을 자동 확정 못 한다. 카드는 항상 `unclassified`로 진입한다."

이 스펙은 write 표면을 **캡처 레인 + 관측 기록**으로 한정한다.

| 노출 (write)              | 근거                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wr_create_signal`        | `signal_store::insert_signal`이 `quadrant='unclassified'`를 SQL에 하드코딩하고 `dedup_key = braindump:normalize(title)`로 upsert한다 → INVARIANT #1·#3 모두 코드로 충족.                    |
| `wr_upsert_timeline_note` | 특정 signal/routine/event에 붙는 자유 메모. 분류·상태를 바꾸지 않는다.                                                                                                                      |
| `wr_toggle_routine_check` | "했다/안 했다"는 관측 사실. 되돌릴 수 있다.                                                                                                                                                 |
| `wr_okr_upsert_check_in`  | 주간 confidence(`on_track`/`at_risk`/`off_track`) + 노트 로그. **KR progress에 영향 없음** — progress는 `current_value` 또는 루틴 파생에서만 나온다. `(kr, week_start)` upsert라 멱등·가역. |

| 차단 (표면에 존재 금지)                                                          | 근거                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| `classify_signal`, `set_signal_kind`, `set_signal_area_tag_key`                  | 매트릭스 분류 = 사람 결정 (#1)                |
| `promote_today`, `unpromote_today`, `toggle_today_done`                          | 승격 = 사람 결정 (#1)                         |
| `create_objective` / `update_objective` / `close_objective` / `delete_objective` | 전략 결정                                     |
| `create_key_result` / `update_key_result` / `delete_key_result`                  | `current_value` → progress → 배지 = 결정 레일 |
| `set_key_result_routine`                                                         | KR↔루틴 자동집계 배선 = 구조 결정             |
| `set_signal_status`, `snooze_signal`, `delete_signal`                            | 상태 확정 = 사람 결정                         |

**가르는 기준: 에이전트는 _사실_ 을 기록할 수 있고, _파생된 판단값을 직접 설정_ 할 수는 없다.**

"판단 산출물로 흘러드는가"는 기준으로 쓰기에 너무 거칠다 — 그 기준이라면 `wr_toggle_routine_check`도
막아야 한다. 루틴에 연결된 KR은 progress를 `routine_checks`에서 **쿼리타임 파생**하기 때문이다
(`commands/okr.rs` `attach_routine_progress`). 즉 MCP로 루틴을 완료 처리하면 OKR 진행률 배지가
실제로 움직인다(테스트로 확인: `surface_tests::routine_toggle_moves_a_routine_linked_key_result_by_design`).

그럼에도 그건 위반이 아니다. 에이전트가 준 것은 "했다"는 **사실**이고, 그 사실이 progress로
흘러드는 규칙(어떤 루틴이 어떤 KR을 먹이는지)은 **사람이 건 링크**다 — `set_key_result_routine`은
MCP 표면에 없다. 규칙은 사람이 정했고 에이전트는 입력만 준다. 가역이고 감사 가능하다.

반면 `update_key_result`의 `current_value`는 그 파생을 **우회해 결과값을 직접 덮어쓴다** —
사실 없이 결론만 놓는 것이므로 차단한다. check-in `confidence`는 어떤 파생값도 구동하지 않는
순수 주간 로그다.

## 4. Caller 정책 — `require_hermes` 폐지 (변경)

**현재:** 로컬 DB write(`save_receipt`, `mark_duplicate`)는 `WORK_RADAR_MCP_CALLER=hermes`일 때만
허용. read는 2026-07-04부터 전 caller 개방.

**변경:** 로컬 SQLite write를 **모든 MCP caller에 개방**한다. `require_hermes`와 그 호출부를 삭제한다.

근거 — 모든 MCP 호스트는 자기 승인 UI를 갖는다. Hermes는 ACP `session/request_permission` 카드,
Claude Code/Codex는 호스트 자체 tool-call 승인. Work Radar가 caller 문자열(에이전트가 보낸
untrusted 값이 아니라 자기가 세팅한 env지만, 다른 호스트가 흉내낼 수 있는 값)로 한 겹 더
게이트하는 것은 **실질 보안을 더하지 않으면서** 다른 호스트에서 로컬 캡처를 불가능하게 만든다.

경계는 그대로 유지된다:

- **외부 서비스 write**(GitHub/Notion/Calendar/Gmail): non-Hermes → `store::enqueue` proposal 큐.
  Hermes → permission card 이후 Rust connector 직접 실행. `McpCaller`는 이 분기를 위해 남는다.
- `Acceptance::mint` 타입-월(`pub(in crate::external_actions)`)은 그대로. mcp는 `store::{approve,reject}`
  및 커넥터 `execute`를 여전히 import/호출하지 않는다.
- 로컬 write는 애초에 Acceptance 게이트 대상이 아니다(INVARIANT #2: "Today 승격은 로컬 SQLite
  액션이라 Acceptance 불요").

기록: `docs/adr/0012-mcp-local-writes-and-calendar-read.md` §1·§2.

## 5. 캘린더 read = 실 Google 조회 (변경)

캘린더 이벤트는 **로컬에 저장되지 않는다** — `calendar_events_cache()`는 앱 프로세스 내부의
60초 TTL in-memory 캐시다. MCP 프로세스는 항상 콜드 스타트이므로 `wr_calendar_list_events`는
매 호출마다 keychain 토큰으로 실제 Google Calendar API를 친다.

이는 `mcp-server-conventions §7`의 "네트워크 없음(Phase 1)"을 명시적으로 개정한다. (사실 이
조항은 Hermes write 커넥터가 land한 시점에 이미 사문화됐다 — `wr_calendar_create_event`는
Google에 POST한다.) 개정 후 규칙:

- MCP는 **read-only outbound**를 허용한다: 대상은 이미 연결된 provider(Google Calendar)뿐이고,
  URL/도메인은 코드 상수이며 **caller 입력이 URL에 닿지 않는다**.
- `fetch_url`/`import_from_url`/임의 API 호출은 **여전히 금지**. caller가 host/path/query를
  지정하는 필드는 스키마에 없다.
- 토큰은 `project_id` → DB `credential_ref` → keychain으로만 해석. 응답 본문은 로그에 남기지 않는다
  (코드+크기만).
- 윈도우 상한 62일 — 무제한 히스토리 덤프 방지.
- bounded retry(`retry.rs` backoff+jitter), terminal failure는 rmcp 에러로 surface.

DTO는 표시 전용 필드를 뺀 최소 집합이다: `id, calendar_id, calendar_summary, title, start, end,
all_day, project_id`. **제외**: `location`, `url`(htmlLink), `project_color`, `project_text_color`,
`recurring_event_id`. 위치·딥링크는 §7 최소권한 관점에서 다른 MCP 서버로 새어나갈 가치가 없다.

기록: `docs/adr/0012-mcp-local-writes-and-calendar-read.md` §3.

## 6. 툴 목록 (신규 14개 → 총 30개)

전부 `#[serde(deny_unknown_fields)]`, 문자열 상한, enum 우선. 반환은 짧은 구조화 JSON.

### `mcp/tools/signals.rs`

1. **`wr_list_signals`** (read) — `status?`, `quadrant?`, `kind?`, `project_id?`, `query?`(FTS),
   `limit?`(1–100, 기본 25). `query`가 있으면 `signal_store::search_signals`, 없으면 `fetch_signals`.
   DTO: `id, title, body_preview(≤280), source, signal_type, quadrant, kind, area, status,
today_for_date, project_id, created_at` + `total`/`truncated`.
2. **`wr_create_signal`** (write) — `title`(1–160), `kind?`, `project_id?`.
   반환 `{id, title, quadrant:"unclassified", deduped}`. `deduped`는 기존 dedup_key에 합쳐졌는지.

`insert_signal`은 현재 dedup 여부를 알려주지 않는다 → `signal_store`에 `(WorkSignal, bool)`을
반환하는 코어를 추가하고 기존 `insert_signal`은 그것을 감싼다(호출부 무변경).

### `mcp/tools/okr.rs`

3. **`wr_okr_get_mission`** (read) — 파라미터 없음. `{statement, note, updated_at}` 또는 `null`.
4. **`wr_okr_list_objectives`** (read) — `quarter`(`^\d{4}-Q[1-4]$`). objective + 중첩 KR
   (`id, title, kind, target_value, current_value, unit, progress, routine_linked: bool`).
   `description`은 ≤280 preview.
5. **`wr_okr_list_check_ins`** (read) — `quarter`. `{key_result_id, week_start, confidence, note_preview}`.
6. **`wr_okr_upsert_check_in`** (write) — `key_result_id`, `week_start`(YYYY-MM-DD),
   `confidence`(enum), `note?`(≤1000).

### `mcp/tools/calendar.rs`

7. **`wr_calendar_list_events`** (read, 네트워크) — `project_id?`, `start_date`, `end_date`(≤62일).

(`wr_calendar_create_event`는 기존 툴 — 이 모듈로 이동만, 무변경.)

### `mcp/tools/today.rs`

8. **`wr_today_overview`** (read) — `date`. **`fetch_today_overview`를 부른다.**
   `today_overview` 커맨드는 `upsert_debt_snapshot`으로 DB에 쓰므로 read 툴에서 부르면 안 된다.
   DTO: work_debt 카운트 + `q1_items`(id/title/quadrant만) + `pr_attention_count`.
9. **`wr_list_today_routines`** (read) — `date`. weekday는 **서버가 date에서 파생**한다(caller가
   보낸 weekday와 date의 불일치 가능성 제거).
10. **`wr_toggle_routine_check`** (write) — `routine_id`, `date`, `done`.
11. **`wr_list_timeline_notes`** (read) — `date`.
12. **`wr_upsert_timeline_note`** (write) — `target_kind`(enum), `target_id`, `date`, `body`(≤4000).
    빈 body = 메모 삭제(기존 `upsert_inner` 계약).

### `mcp/tools/bookkeeping.rs`

13. **`wr_bookkeeping_budget_status`** (read) — `month`, `project_id?`.
14. **`wr_bookkeeping_list_recurring_expenses`** (read) — `project_id?`.

(기존 7개 가계부 툴 이동 + `save_receipt`/`mark_duplicate`에서 `require_hermes` 제거.)

합계: 신규 14개(위 1–14) + 기존 16개 = **30개**.

## 7. 모듈 경계 (구조)

```
src-tauri/src/mcp/
  mod.rs            # WrServer, McpCaller, tool_router() 합성, ServerHandler, 에러 헬퍼
  write_routing.rs  # HermesMcpExecutor, route_write_for_caller, enqueue_write_proposal, stable_idem_key
  dto.rs            # 공용 DTO 헬퍼(enum_wire_string, truncate_preview)
  run.rs            # --mcp-stdio 진입 (무변경)
  tools/
    queue.rs        # list_pending_actions, action_status, propose_noop, list_projects
    github.rs       # github_comment, github_create_issue
    notion.rs       # notion_create_page
    gmail.rs        # gmail_send
    calendar.rs     # calendar_create_event, calendar_list_events
    bookkeeping.rs  # 기존 7 + budget_status, list_recurring_expenses
    signals.rs      # list_signals, create_signal
    okr.rs          # get_mission, list_objectives, list_check_ins, upsert_check_in
    today.rs        # today_overview, list_today_routines, toggle_routine_check,
                    # list_timeline_notes, upsert_timeline_note
```

각 도메인 모듈은 `#[tool_router(router = tool_router_<domain>, vis = "pub(crate)")] impl WrServer`
블록 하나를 갖고, 자기 DTO·정제 로직·단위 테스트를 소유한다.

`mod.rs`는 라우터를 합성한다:

```rust
impl WrServer {
    pub fn tool_router() -> ToolRouter<Self> {
        tools::queue::tool_router_queue()
            + tools::github::tool_router_github()
            + ... // 9개
    }
}

#[tool_handler]              // router 기본값 = Self::tool_router()
impl ServerHandler for WrServer {}
```

`#[tool_handler]`의 `router` 기본값이 `Self::tool_router()`이므로 **`WrServer` 구조체에 필드를
추가하지 않아도 되고**, `run.rs`의 `WrServer { db }`와 기존 테스트의 `WrServer::tool_router()`가
그대로 컴파일된다. `get_info`를 수동 구현하지 않으면 매크로가 기존 `server_handler`와 동일한
name/version/capabilities를 생성한다 → **동작 무변경**.

## 8. 에러 처리

기존 계약 유지: DB 에러를 빈 목록으로 삼키지 않고 rmcp internal-error로 surface한다(폴링
에이전트가 "실패"와 "비어 있음"을 구분). `mcp_tool_error`/`db_tool_error`가 `AppError.code`만
싣는다 — message/payload 본문·PII 금지.

캘린더 read의 terminal failure(미연결, 토큰 만료, Google 5xx 소진)는 `AppError`로 올라와 동일
경로로 변환된다. 미연결은 `calendar.not_connected`.

## 9. 검증

- **스키마/표면 고정:** `registered_tool_set_is_locked` 테스트를 30개 이름으로 갱신.
  `deny_unknown_fields`가 생성 JSON Schema에 `additionalProperties:false`로 박혔는지 확인하는
  기존 prop-name 테스트를 신규 param struct에 확장.
- **모듈 분할 검증:** 분할 커밋은 **순수 이동** — 툴 이름 집합·스키마 해시가 분할 전후 동일해야
  한다. `registered_tool_set_is_locked`가 그 가드다.
- **결정 레일 회귀 가드:** 금지 툴 이름(§3 표)이 라우터에 **없음**을 단언하는 테스트를 추가한다.
  이름 allowlist 하나로는 "실수로 추가"를 못 막으므로 denylist를 함께 둔다.
- **캡처 레인 가드:** `wr_create_signal`이 만든 행의 `quadrant`가 항상 `unclassified`임을 단언.
  두 번 호출하면 같은 id를 반환(dedup)함을 단언.
- **caller 정책:** 로컬 write 툴이 `McpCaller::Other`로도 성공함을 단언(기존 hermes-gated 테스트
  2개를 개정). 외부 서비스 write는 여전히 non-Hermes → enqueue임을 기존 테스트로 유지.
- **순수 read 가드:** `wr_today_overview` 호출이 `debt_snapshots`에 행을 만들지 않음을 단언.
- `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- 헤드리스 stdio 라운드트립(`tests/mcp_roundtrip.rs`) 확장: 신규 read 툴 1개 + `wr_create_signal`.
- **실 Google 캘린더 스모크는 사용자** — 이 세션에서 실행 못 한다고 명시한다.

## 10. 슬라이스

| #   | 내용                                                                  | 위험 |
| --- | --------------------------------------------------------------------- | ---- |
| 1   | `mcp/` 모듈 분할 (순수 이동, 툴 집합 불변)                            | 중   |
| 2   | ADR-0012 + `mcp-server-conventions.md`/`decision-rails.md` 개정       | 낮   |
| 3   | `require_hermes` 폐지 + 테스트 개정                                   | 낮   |
| 4   | signals: `wr_list_signals`, `wr_create_signal` (+ store dedup 리포트) | 낮   |
| 5   | okr: 4개 툴                                                           | 낮   |
| 6   | today/routines/timeline: 5개 툴                                       | 중   |
| 7   | calendar read 1개 (네트워크 경계)                                     | 중   |
| 8   | bookkeeping read 2개 + 결정레일 denylist 테스트                       | 낮   |

각 슬라이스: 구현 → 게이트(test/clippy/fmt) → critic 패스(별도 컨텍스트, self-approve 금지) → 커밋.

## 11. 잔여 위험

- **캘린더 read의 지연.** MCP 프로세스는 캐시가 콜드라 매 호출이 Google 라운드트립이다. 에이전트가
  루프에서 호출하면 rate limit에 걸린다. 완화: 프로세스 내 TTL 캐시를 MCP에서도 재사용
  (`calendar_events_cache()`는 `OnceLock` static이므로 MCP 프로세스에서도 동작한다 — 같은 프로세스
  안 반복 호출은 60초간 캐시된다). 완전한 해소는 §2 비목표의 로컬 캐시 테이블 트랙.
- **로컬 write 개방의 blast radius.** 악성/오작동 MCP 호스트가 신호를 대량 생성할 수 있다. dedup_key가
  동일 제목 반복을 흡수하지만 서로 다른 제목은 못 막는다. 현재 결정: 수용(로컬·가역·감사 가능).
  신호 삭제는 표면에 없으므로 파괴적이지 않다.
- **`wr_upsert_timeline_note`의 빈 body = 삭제.** 에이전트가 빈 문자열을 보내면 기존 메모가 사라진다.
  스키마에서 `body` 최소 길이를 강제하지 않고 기존 커맨드 계약을 그대로 따른다 — 삭제 의도를 별도
  툴로 분리하지 않는다(표면 최소화). 대신 tool description에 명시한다.

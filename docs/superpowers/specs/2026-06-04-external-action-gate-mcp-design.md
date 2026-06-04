# External Action Gate + MCP Surface — Design Spec

- Date: 2026-06-04
- Status: Approved (brainstorm) → pending writing-plans
- Scope owner area docs: `docs/areas/ipc-conventions.md`, `docs/areas/decision-rails.md`, `docs/areas/data-layer-conventions.md`
- Related ADR (to author): generalized external-action gate (supersedes codex-only Acceptance scope)

## Goal

외부 서비스 연동(Notion / GitHub / Google Calendar / Gmail)을 **쓰기 가능까지 전면
개방**하되, 외부 AI 에이전트가 work-radar를 통해 그 쓰기를 **제안만** 하고 실제 실행은
**사용자 승인 후 Rust 커넥터**가 수행하도록 한다. 이를 통해 "AI가 앱을 조작" 요구를
충족하면서 레포 최상위 INVARIANT #1(자동화의 결정 레일 침범 금지)을 **코드로 강제**한다.

비목표(YAGNI): ungated 자동 실행, 렌더러/AI로의 토큰 노출, MCP의 직접 외부 호출,
별도 MCP 바이너리(앱 내장 stdio로 시작), 새 producer 도입.

## Core Insight

MCP 툴 surface는 **proposal 생성기일 뿐 실행기가 아니다.** 단일 `external_actions`
큐가 유일한 초크포인트이고, 실행은 Rust 전용이며, 토큰은 keychain에만 있다. AI는
토큰을 쥐지 않고 실행도 하지 않고 '제안'만 한다 — 이것이 외부 개방과 결정 레일
불변을 동시에 만족시키는 유일한 합법 경로다.

## Architecture (§1)

```
외부 에이전트(Claude/Codex/Hermes)
        │  MCP 툴 호출 (예: wr_github_comment, wr_gmail_send)
        ▼
 work-radar MCP server (Rust, 앱 내장 stdio)
   - write 툴 = proposal 생성기 (실행 안 함, 토큰 미접근)
   - read 툴  = 캐시/조회 반환 (토큰은 Rust 내부만)
        │  enqueue
        ▼
 external_actions 큐  (단일 초크포인트, status=awaiting_approval)
        │  사용자 승인 (FE approval panel)
        ▼
 ExternalConnector 트레잇 디스패치 (Rust 전용 실행, keychain, bounded retry)
        │  결과 + PII-free 기록
        ▼
 external_action_audit (append-only)
```

타입 레벨 불변 3종:
1. MCP write 툴 본문은 `enqueue_proposal()`만 호출 — 커넥터 `execute()`로의 코드
   경로가 모듈 경계상 존재하지 않음.
2. 커넥터 `execute()`는 `Acceptance` 토큰을 인자로 요구 → 승인 없이 호출 불가(컴파일 강제).
3. 모든 `execute()` 진입/종료가 audit에 기록(PII-free 계약).

## Data Model (§2)

신규 마이그레이션(기존 `acceptances`/`agent_runs` 패턴의 일반화; 결합도를 낮추기 위해
codex 잡 테이블을 확장하지 않고 **신규 테이블로 분리**):

```sql
CREATE TABLE external_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,   -- "github.comment" | "gmail.send" | "notion.update" | "calendar.create" ...
  project_ref   TEXT,            -- credential_ref (토큰 격리)
  payload       TEXT NOT NULL,   -- 검증된 JSON (PII 가능 → 로컬 SQLite만, 로그 금지)
  preview       TEXT,            -- 사용자에게 보일 사람-친화 요약
  origin        TEXT NOT NULL,   -- "mcp:<agent>" | "codex:<run_id>" | "hermes:<tab>"
  status        TEXT NOT NULL,   -- proposed | awaiting_approval | executing | succeeded | failed | rejected
  result        TEXT,            -- 외부 응답 메타 (id/크기, 본문 금지)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);

CREATE TABLE external_action_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id     INTEGER NOT NULL,
  event         TEXT NOT NULL,   -- "enqueued" | "approved" | "executed" | "rejected" | "failed"
  detail        TEXT,            -- "service=github,bytes=412" — 시크릿/본문 금지
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rust 코어 타입:

```rust
pub enum ExternalAction {
    NotionUpdate(NotionUpdatePayload),
    GithubComment(GithubCommentPayload),
    GithubCreatePr(GithubPrPayload),
    GmailSend(GmailSendPayload),
    CalendarCreate(CalendarEventPayload),
    // 변형 추가 = 새 커넥터 비용 전부 (게이트/승인 UI/감사 공짜)
}

pub trait ExternalConnector {
    type Payload;
    async fn execute(&self, payload: &Self::Payload, _gate: &Acceptance)
        -> Result<ExecOutcome, AppError>;   // Acceptance 인자 = 승인 없이 호출 불가
}
```

`Acceptance`는 승인 경로(`approve_external_action` IPC)에서만 생성되는 토큰 타입
(생성자 private) → 타입 시스템이 INVARIANT #2를 강제. id PK는 항상 `i32`(specta i64 금지).

## MCP Surface (§3)

work-radar가 **앱 내장 stdio MCP 서버**를 노출. 외부 에이전트가 등록하면 툴이 보임.

| 툴 | 유형 | 동작 | 반환 |
|---|---|---|---|
| `wr_list_projects`, `wr_read_signals`, `wr_pr_status` | READ | 캐시/조회 | 데이터 |
| `wr_github_comment`, `wr_github_create_pr`, `wr_github_create_issue` | WRITE | enqueue | `{action_id, status:"awaiting_approval"}` |
| `wr_notion_update`, `wr_notion_create_page` | WRITE | enqueue | action_id |
| `wr_gmail_send`, `wr_gmail_draft` | WRITE | enqueue | action_id |
| `wr_calendar_create`, `wr_calendar_move` | WRITE | enqueue | action_id |
| `wr_action_status(action_id)` | READ | 승인/실행 상태 폴링 | status |

계약:
- write 툴 본문 = payload 검증 → `enqueue_proposal(kind, payload, origin)` 호출만.
  커넥터 `execute()`로의 경로 없음(모듈 경계).
- read 툴도 토큰은 Rust 내부에서만, 응답은 정제된 데이터만.
- `wr_action_status` 폴링은 **bounded**(terminal: rejected/failed/succeeded 도달 시
  종료) — 무한 폴링 금지.
- MCP 서버는 앱 내장 stdio로 시작(별 바이너리 YAGNI).

## Phasing (§4)

각 Phase = 1 PR = 1 관심사. 각 PR: 구현 → cargo/clippy/fmt/typecheck/lint/vitest →
critic(opus 별도 패스) ACCEPT → dev 푸시(사용자 명시 요청 시에만).

- **Phase 0 — Keystone: 통합 게이트 + 감사 (커넥터 0).**
  마이그레이션 2종, `ExternalAction` enum, `ExternalConnector` 트레잇, `Acceptance`
  토큰. IPC: `enqueue_external_action`(내부), `list_pending_actions`,
  `approve_external_action`, `reject_external_action`, `action_status`. FE: 통합 승인
  패널 — 기존 inbox tray / acceptances UI 확장(새 surface 금지). 외부 호출 0.
  테스트: enqueue→approve→(mock execute)→audit 라운드트립.
- **Phase 1 — MCP 서버 (proposal-only, 커넥터 mock).**
  stdio MCP 서버, read 툴 + write 툴(enqueue만), `wr_action_status`. 헤드리스 MCP
  라운드트립 테스트(실 외부호출 0).
- **Phase 2 — GitHub WRITE 승격.**
  `github.rs` PrProvider에 `create_comment`/`create_issue`/`create_pr` 추가(bounded
  retry, keychain). `ExternalConnector` impl. MCP 툴 3개 wire. 승인 패널 GitHub preview.
- **Phase 3 — Notion WRITE 확장.**
  속성 업데이트/코멘트/페이지 생성 확장 → 커넥터 impl → 툴 → preview.
- **Phase 4 — Calendar WRITE 확장(AI 제안).**
  AI 제안 이벤트는 `external_actions` 경유, **사용자 폼 제출은 기존
  `pending_calendar_writes` 경로 유지**. 이중 게이트 금지 — 두 경로의 단일화 경계를
  spec에 명시(AI-origin만 external_actions, human-origin은 기존 큐).
- **Phase 5 — Gmail 신규.**
  `TokenKind::Gmail`, OAuth(PKCE, 기존 `calendar/oauth.rs` 패턴 재사용), 읽기 커넥터 +
  발송 커넥터(발송=gated). 가장 큰 신규 작업.

의존성: Phase 0이 keystone, 1은 0 위. **2~5는 0/1 위에서 서로 독립** → 병렬 디스패치
가능(codex:1 + claude:1 분담).

## INVARIANT Mapping & Testing (§5)

| INVARIANT | 보장 방식 |
|---|---|
| #1 자동화 결정레일 침범 금지 | MCP write 툴 = enqueue만, 실행은 승인 후. 타입 경계 강제 |
| #2 외부 mutation 전 Acceptance | `execute(_, gate: &Acceptance)` — 승인 토큰 없이 호출 불가(컴파일 강제) |
| 토큰=keychain, 렌더러/AI 미노출 | 토큰은 Rust 커넥터 내부만. MCP·FE에 안 감 |
| 외부 호출=Rust | 모든 `execute()`가 Rust. MCP/FE는 proposal id만 |
| bounded retry only | 기존 `with_retry` 재사용. 무한 폴링 금지(terminal 노출) |
| 로그 PII/시크릿 금지 | `external_action_audit`=service+bytes만. payload는 로컬 SQLite만 |
| IPC=tauri-specta 생성 | 새 커맨드 전부 `#[specta::specta]`, bindings.ts 재생성=`cargo test` |
| AppError 단일 envelope | 커넥터 에러 → `From` → AppError |

테스트 전략: 커넥터별 트레잇 mock seam(기존 NotionWriter/PrProvider 패턴 재사용).
게이트는 enqueue→approve→execute→audit 라운드트립. MCP는 헤드리스 stdio 라운드트립.
실 외부호출은 **사용자 라이브 스모크**(에이전트 불가 — 명시).

## Open Decisions (확정)

- 신규 테이블 분리 (codex `agent_runs` 확장 아님) — 확정.
- `Acceptance` 토큰 타입 레벨 강제 — 확정.
- Phase 4 Calendar 이중 경로: AI-origin=external_actions / human-form=기존 큐 — 확정.
- MCP 서버 앱 내장 stdio 시작(별 바이너리 보류) — 확정.

## Risks / Rollback

- 게이트 일반화가 기존 codex `acceptances` 경로와 공존 — Phase 0에서 기존 경로 회귀
  없는지 별도 reviewer 패스로 확인. 롤백=마이그레이션 down + 신규 커맨드 제거(기존
  경로 무변경이므로 격리 롤백 가능).
- MCP write 툴이 실수로 execute 경로에 닿으면 INVARIANT #1 위반 → 모듈 경계 + 타입
  토큰 + 테스트 3중 방어.
- Gmail OAuth scope 과다 위험 → 최소 scope(읽기 + 발송)만, opt-in.

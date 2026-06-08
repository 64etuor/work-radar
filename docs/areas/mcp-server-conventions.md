---
status: live
owner: repo-maintainers
last_reviewed: 2026-06-04
source_of_truth_scope: work-radar MCP 서버(`--mcp-stdio`) durable 규율 — proposal-only 경계, 툴 표면 제약, 입력/출력 안전, stdio 실행 경계
---

# MCP Server Conventions — `work-radar --mcp-stdio`

이 문서는 work-radar에 **내장된 stdio MCP 서버**(외부 AI 에이전트가 spawn)의 **레포
durable** 규율이다. 외부 호출/keychain/bounded retry 일반 규율은
`docs/areas/ipc-conventions.md`에, INVARIANT 본문은 `docs/areas/decision-rails.md`에,
SQLite·마이그레이션은 `docs/areas/data-layer-conventions.md`에 있다 — **중복하지 않는다.**

설계 정본: `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md` §3.
Phase 계획: `docs/superpowers/plans/2026-06-04-external-action-gate-phase1.md`.

## 핵심 불변 — MCP는 "제안 생성기"이지 "행위 실행기"가 아니다

> **MCP 서버는 외부 AI가 작업을 *제안*만 하는 표면이다. 실행은 사용자 승인 후
> Rust 커넥터 전용.** 이것이 INVARIANT #1(결정 레일은 사람만) / #2(외부 변경은
> Acceptance 게이트)를 **MCP 표면에서 코드로 강제**하는 방식이다.

```text
외부 에이전트 → work-radar --mcp-stdio → (validate/normalize/idempotency)
            → store::enqueue(proposal) → external_actions 큐(awaiting_approval)
            → Tauri 앱에서 사람이 승인 → Rust ExternalConnector::execute(&Acceptance)
```

MCP 툴 본문은 `external_actions::store::{enqueue,list_pending,status}`만 호출한다 — 이것이 계약.
무엇이 어떻게 강제되는지 정확히:

- **컴파일로 강제됨:** `Acceptance::mint`은 `pub(in crate::external_actions)`라 mcp 모듈에서
  승인 토큰을 위조할 수 없다(trybuild compile-fail로 잠금) → 커넥터 `execute(&Acceptance)`를 직접 못 부른다.
- **아직 컴파일로 막히지 않음(durable 규칙으로 금지):** `store::{approve,reject}`는 현재
  `pub(crate)`라 같은 crate의 mcp 모듈이 호출하면 사람 게이트를 **우회**할 수 있다.
  → **mcp 모듈은 `store::{approve,reject}`·`ExternalConnector`·커넥터 execute 경로를 import/호출하지 않는다**
  (리뷰 + 이 문서로 강제). **경화 권장:** `approve`/`reject`를 gate 서브모듈로 좁혀 mcp에서 도달
  불가하게 만들면 type-wall이 됨 — 그 전까지는 컴파일 보장이 아니라 계약임을 명시.
- 위반(`approve`/`reject`/execute를 mcp에서 호출) = INVARIANT #1/#2 위반 = 차단.

## 1. 툴 표면 — 좁게 고정

| 허용                                                                    | 금지                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| READ 조회 (`wr_list_pending_actions` 등, 캐시/메타)                     | `approve_*` / `execute_*` / `delete_*`                |
| WRITE = enqueue만 (`wr_propose_*` → `store::enqueue`)                   | `mutate_db` / `raw_sql` / admin·migration·repair      |
| 상태 폴링 (`wr_action_status`, 단건 조회 — 폴링 종료는 클라이언트 책임) | `run_shell` / `fetch_url` / 임의 file read / env dump |

- 읽기 툴 예시(`wr_list_pending_actions`)는 **현재 Phase 1 표면**. spec §3는 더 넓은 target
  표면(`wr_list_projects`/`wr_read_signals`/`wr_pr_status` 등 cache read)을 나열한다 —
  **read 표면은 Phase별로 확장되지만 write 툴 계약(enqueue만)은 불변.**
- 툴 목록은 **startup 시 고정** — 런타임 동적 registration 금지(rug pull 방어).
- 툴 표면 변경 = 명시적 코드 변경 + 스키마 스냅샷 테스트 갱신(아래 §8).

## 2. 입력 스키마 — strict, 좁은 타입

rmcp + `schemars(JsonSchema)` + serde로 스키마가 **Rust param struct에서 생성**된다.
따라서 generic JSON-schema 손작성이 아니라 타입으로 좁힌다:

- param struct에 `#[serde(deny_unknown_fields)]` (런타임 unknown-field 거부 = `additionalProperties:false`
  등가). **중첩 struct마다 개별 적용** — serde는 상속하지 않으므로 nested payload 타입에도 붙인다.
  스키마 스냅샷(§8)이 **생성된 JSON Schema에 `additionalProperties:false`가 실제로 박혔는지** 확인.
- 자유 문자열 대신 **enum**(`kind` 등), 문자열은 `maxLength`/패턴 검증을 핸들러 진입에서.
- **받지 않는 필드:** `raw_sql`, `command`, `path`, `url`, `script`, `shell`,
  `where_clause`, `filter_expr` — Phase 1 표면에 존재 금지.
- payload/preview에 길이 상한(예: title ≤160, summary ≤4000) + 전체 payload 크기 상한.
- 입력 검증은 **트랜잭션 밖**에서 끝낸다(§4).

## 3. Idempotency — 중복 enqueue 방지

- MCP/에이전트 호출은 재시도된다. enqueue가 중복 proposal을 만들면 승인 UX가 망가진다.
- idempotency key를 **요구하거나 정규화 입력에서 파생** → `external_actions`에 unique
  partial index(`WHERE idempotency_key IS NOT NULL`).
- 중복이면 새 행 생성 없이 **기존 `action_id` 반환**(`status: already_exists`).
- 컬럼/인덱스가 Phase 0 테이블에 없으면 **마이그레이션으로 추가**(임의 ALTER 금지 —
  `data-layer-conventions.md`).
- **스코프:** Phase 1 `wr_propose_noop` 데모는 idempotency 없이도 무방하나, **실 커넥터
  write 툴(GitHub/Notion/… , Phase 2+)이 land하기 전에는 위 인덱스/키가 필수.** 즉 사용자에게
  실제 영향을 주는 write 툴 도입 = idempotency 마이그레이션 동반.
- **키는 제안 *내용*에서 파생한 안정값**(시도별 UUID 금지 — dedup이 절대 안 걸림). GitHub write
  툴은 `sha256(project_id ‖ kind ‖ payload-json)`을 키로 쓴다(`mcp/mod.rs::stable_idem_key`).
  같은 외부 쓰기의 재시도는 같은 키 → 활성 동일 키에 dedup(`enqueue_with_idempotency`).
- **잔여 위험 — idempotency*key는 *제안* dedup이지 \_API 효과* dedup이 아니다(#5).** POST가
  GitHub에 도달한 뒤 **응답만 유실**되면 액션은 `failed`로 표시되고(쓰기 재시도는 중복 mutation
  위험이라 `WRITE_MAX_ATTEMPTS=1`), 사람이 재제안하면 **중복 코멘트/이슈**가 날 수 있다. 키는 새
  제안 행을 막을 뿐 이미 일어난 외부 효과를 되돌리지 못한다. 현 결정(`decisions.md` 2026-06-04):
  잔여를 **명시 노출**한다 — 승인 패널이 GitHub write 액션에 "전송 후 응답 유실 시 재승인은 중복
  쓰기일 수 있음" 캡션을 보이고, check-before-write/read-back 자동 dedup은 **deferred**(실 GitHub
  API 라운드트립 필요 — 라이브 스모크는 사용자). 첫 시도 안전(at-most-once 제안), 재제안만 잔여.
- **같은 증상의 두 번째 트리거(크래시 윈도).** 커넥터 `execute`가 성공 반환한 뒤 "executed" 감사를
  커밋하기 _전에_ 프로세스가 죽으면, reaper가 그 행을 (executed 감사가 없으니) `failed`로 정리한다 —
  실제로는 쓰기가 일어났는데 failed로 보고된다. 윈도는 sub-ms이고, 네트워크 쓰기 + 로컬 DB에 걸친
  분산 트랜잭션 없이는 닫을 수 없다(불가피). 사용자-노출 증상은 위 "응답 유실"과 동일 → 같은 승인
  패널 캡션이 커버한다. (정상 경로: "executed"를 상태 플립 _전에_ 기록하므로, finalize만 실패한
  대다수 크래시는 reaper가 `succeeded`로 reconcile한다 — 이 잔여는 그 직전 sub-ms 윈도만 해당.)

## 4. SQLite 경합 — 짧은 insert-only writer

- MCP 프로세스는 앱과 **동일 app-data DB**를 연다(앱 DB resolver 재사용 — 경로 하드코딩 금지).
  debug/dev와 release/prod를 분리하지 않는다. 앱이 이미 pool pragma(WAL 등)를 설정하므로
  MCP는 **새 pragma를 임의 설정하지 않는다**.
- MCP 핸들러 트랜잭션은 `validate(밖) → BEGIN → INSERT proposal → COMMIT`만.
  **tx 안에서 LLM/네트워크/파일/긴 계산 금지.**
- `SQLITE_BUSY`는 bounded retry(backoff+jitter, `retry.rs` 패턴) — 무한 재시도 금지.
- approval/merge/conflict 해소는 전부 앱(GUI) 쪽 — MCP는 insert writer일 뿐.

## 5. stdio 실행 경계 — config를 외부 입력으로 만들지 않는다

최근 MCP stdio RCE 패턴(Flowise/Agent Zero)의 핵심은 "command/args가 검증 없이 실행"이다.
work-radar는 반대로:

- 등록 = **고정 바이너리 + 고정 args**: `{ "command": "<abs>/work-radar", "args": ["--mcp-stdio"] }`.
- command/args를 **LLM이 생성하지 않게**, remote project/user content에서 읽지 않게.
- `sh -c`/`bash -c`/`node -e`/동적 args 조합 금지 — allowlist된 바이너리만.
- `--mcp-stdio` 분기는 **GUI 부팅 경로를 건드리지 않는다**(플래그 없으면 기존 `run()`).
- **stdout = MCP 프레이밍 전용.** 로깅/tracing은 stderr로(또는 끔) — stdout 오염 = 프로토콜 파손.
- MCP 모드에서 shell 실행·임의 file read·env dump·admin/migration/repair 커맨드 **차단**.

## 6. Annotations·description·output — hint이지 보장이 아니다

- 툴 annotation은 **위험 어휘(hint)일 뿐 enforcement가 아니다.** 안전은 §1~§5(표면
  제약·스키마·proposal-only·DB 제약)가 만든다 — annotation에 의존 금지.
- proposal write 툴 권장값: `readOnlyHint:false`(행 추가) · `destructiveHint:false`(사용자
  -visible state 직접 변경 안 함) · `idempotentHint:true`(idempotency key 기준) ·
  `openWorldHint:false`(네트워크 없음).
- **description = 기능 설명만.** "Use this whenever possible / ignore other tools /
  don't ask confirmation" 류 모델 지시문 금지(tool poisoning 표면).
- **output = 짧은 구조화 JSON만**(`{action_id, status, requires_user_approval}`).
  user-provided `title`/`summary`/`evidence`를 그대로 장문 echo 금지 — 필요 시
  truncated preview만(output도 다음 툴의 injection 입력이 될 수 있음).

## 7. 네트워크·토큰·다중서버 — 능력을 주지 않는다

- **네트워크 없음(Phase 1).** `fetch_url`/`import_from_url`/`sync_remote`/webhook/
  OAuth proxy/임의 API 호출 금지. (후일 필요 시: domain allowlist + HTTPS only +
  private/link-local/localhost block + redirect hop 검증 + timeout + 응답 크기 상한 +
  credential 미전달 — 그때 ADR로.)
- **token passthrough 금지.** MCP 입력에 `access_token`/`refresh_token`/API key/cookie/
  `Authorization` 받지 않는다. 토큰은 Rust 커넥터 내부 keychain만(ipc-conventions).
- **다중서버 조합 전제.** Hermes 세션에 다른 MCP 서버가 같이 붙어도 피해가 작도록,
  work-radar MCP는 외부 _전송_ 능력(email/Slack/HTTP post/shell/browser/임의 file read)을
  **갖지 않는다** — proposal 큐만.
- **read 툴 = 최소권한.** 전송 능력이 없어도 read 툴이 민감 캐시를 통째로 뱉으면 _다른_ MCP
  서버가 유출할 수 있다. read 툴은 project-scoped + 기본 metadata/정제 preview만 반환하고,
  토큰·raw 외부응답 본문·pending action payload 전문을 반환하지 않는다(필요 시 별도 사용자
  승인 disclosure 경로로만).

## 8. 감사·provenance·스키마 고정

- **invocation 감사**(proposal row와 별도): timestamp · tool_name · 정규화 args 해시 ·
  action_id · client label · session_id(가능 시) · result_status · error_code.
  `summary` 전문 중복 저장 금지(payload는 `external_actions`에만) — 시크릿/PII redaction.
  (Phase 0 `external_action_audit`는 `action_id/event/detail`만 — 위 필드가 없으면
  마이그레이션으로 추가, 임의 ALTER 금지.)
- **provenance**를 proposal origin에 기록: `mcp:<client>`(예: `kind/server/client/tool/
session_id/input_hash`) — "이 proposal이 왜 생겼나"를 사용자가 추적 가능. 단 `client`/
  `session_id`는 **에이전트가 보낸 untrusted provenance** — 표시·감사용일 뿐 auth/policy 입력 금지.
- **승인 preview는 Rust가 정규화된 payload에서 파생한다(confused-deputy 방어).** 사람이 승인 시
  보는 핵심 요약은 절대 에이전트 자유텍스트가 단독 근거가 되면 안 된다 — benign `preview` +
  harmful payload 조합으로 사람을 속일 수 있다. 승인 UI는 실제 `ExternalAction` payload에서
  Rust로 렌더한 텍스트를 1차로 표시하고, MCP가 보낸 `preview`는 보조 note로만 취급한다.
- **스키마 스냅샷 테스트.** 툴 name/schema/description 해시를 테스트로 고정
  (`cargo test mcp_tool_schema_snapshot` 류) — 의도치 않은 표면 변경 = 테스트 실패.

## 명시적 금지 (Forbidden — 미루는 게 아니라 금지)

1. MCP에서 approve/execute/delete 제공.
2. 임의 shell/command/path/url/sql 입력 필드.
3. MCP server config(command/args)를 LLM/user content에서 생성.
4. OAuth/token passthrough.
5. 네트워크 fetch(Phase 1).
6. tool output에 user content 장문 echo.
7. annotation을 보안 보장으로 간주.
8. 런타임 동적 tool mutation.
9. 앱 프로세스와 직접 IPC로 권한 위임(승인은 GUI·DB 큐 경유만).
10. DB 트랜잭션 안에서 느린 작업(LLM/네트워크/파일).

## 강제 계약 (durable — 라이브 phasing/현황은 plan/spec)

- **모든 write 툴(현재·미래)의 본문 = `store::enqueue`만.** 커넥터별 PR로 GitHub/Notion/
  Calendar/Gmail write 툴이 추가돼도 본문은 §1·§2·§8을 그대로 상속 — `execute`/`approve` 경로 없음.
- **read 표면은 Phase별로 확장**하되 토큰/payload 본문 미노출(§6·§7)은 불변.
- **검증 계약:** 헤드리스 stdio 라운드트립(propose→enqueue→list/status, 외부호출 0) +
  스키마 스냅샷(§8) + `cargo test`/clippy `-D warnings`/fmt. 실 외부호출 라이브 스모크는 **사용자**.

## 정본 / 참조

- `src-tauri/src/mcp/` — MCP 핸들러(`WrServer`) + `--mcp-stdio` 진입(`run.rs`).
- `src-tauri/src/external_actions/` — `store::{enqueue,list_pending,status}`, `gate`
  (`Acceptance` 토큰 type-wall — MCP의 proposal-only 보장이 의존하는 경계).
- `docs/areas/ipc-conventions.md` — 외부 호출/keychain/bounded retry/Acceptance 게이트.
- `docs/areas/decision-rails.md` — INVARIANT #1·#2 본문(이 문서가 MCP 표면에서 mechanize).
- `docs/areas/data-layer-conventions.md` — 마이그레이션·WAL·SQLite 규율.
- `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md` — 설계 정본 §3.
- 참고(레퍼런스): MCP Security Best Practices, OWASP MCP Security Cheat Sheet,
  MCP Tool Annotations(hints≠guarantees) — 외부 위협 모델 근거.

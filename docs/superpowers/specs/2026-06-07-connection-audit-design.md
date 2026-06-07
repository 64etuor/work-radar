# 연결 점검 (Connection Audit) — 설계

작성일: 2026-06-07 · 브랜치: `feat/connection-audit` · 상태: 승인됨(설계)

## 문제 / 동기

설정 통합 화면은 연결을 **프로젝트별·서비스별로 따로** 확인해야 한다(토큰 Test ping, Notion 연결
테스트, Google/Gmail 연결 상태 각각). 전체를 한 번에 점검하는 수단이 없고, 같은 레포/DB/계정이
여러 프로젝트에 중복 설정돼도 알려주지 않는다. 특히 **개인 토큰과 업무 토큰의 분리**가 의도대로
유지되는지(같은 계정이 개인·업무에 걸쳐 쓰이는지) 한눈에 볼 방법이 없다.

→ 설정 통합 상단의 **"연결 점검" 버튼 하나**로 전 프로젝트 연결을 일괄 검증하고, 중복·환경 문제와
**개인/업무 분리 위반 가능성**을 경고한다.

## 비목표 (YAGNI)

- 자동 수정/정리(중복 해제 버튼 등) — 경고만. 수정은 기존 per-project UI(레포 삭제·DB 편집·토큰
  삭제)로.
- 주기적/백그라운드 자동 점검 — 버튼 누를 때 1회만(on-demand).
- cmux/터미널 그 자체 감지 — 무관(앱은 Tauri 데스크톱). "연결 감지"=연결 헬스체크로 확정.

## 접근 (승인: A)

Rust 단일 집계 커맨드 `run_connection_audit`가 전 프로젝트를 bounded 검증하고 중복·환경 분석까지
한 구조체로 반환 → 프런트는 IPC 1회 호출 후 결과 패널 렌더. 외부 호출·토큰·판정 로직을 전부
Rust에 둬 INVARIANT(토큰 렌더러 미노출, 외부 호출 Rust, bounded)를 지킨다.

## 데이터 구조 (Rust, specta `Type` + camelCase 직렬화)

신규 모듈 `src-tauri/src/models/audit.rs` (models.rs에 `pub mod audit; pub use audit::*;`).

```rust
pub struct ConnectionAudit {
    pub projects: Vec<ProjectConnectionStatus>,
    pub duplicates: DuplicateWarnings,
    pub environment: Vec<EnvWarning>,
}

pub struct ProjectConnectionStatus {
    pub project_id: String,
    pub name: String,
    pub kind: ProjectKind,            // personal | work
    pub github: ConnCheck,
    pub notion: ConnCheck,
    pub notion_backlog_db: ConnCheck, // 바인딩 없으면 NotConfigured
    pub notion_agenda_db: ConnCheck,
    pub google_calendar: ConnCheck,
    pub gmail: ConnCheck,
}

pub enum ConnState { NotConfigured, Ok, Failed }

pub struct ConnCheck {
    pub state: ConnState,
    pub detail: String,   // login/bot/title/에러 메시지. 토큰 본문 절대 없음(INVARIANT).
}

pub struct DuplicateWarnings {
    pub repos: Vec<DuplicateGroup>,      // 같은 owner/repo 또는 같은 local_path
    pub notion_dbs: Vec<DuplicateGroup>, // 같은 DB id
    pub accounts: Vec<AccountDuplicate>, // 같은 github login / notion bot
}

pub struct DuplicateGroup {
    pub identity: String,                // "owner/repo" | local path | db id
    pub projects: Vec<AuditProjectRef>,
}

pub struct AccountDuplicate {
    pub service: String,                 // "github" | "notion"
    pub identity: String,                // login | bot 이름
    pub projects: Vec<AuditProjectRef>,
    pub cross_kind: bool,                // 그룹이 personal+work 둘 다 포함 → 강조 경고
}

pub struct AuditProjectRef { pub id: String, pub name: String, pub kind: ProjectKind }

pub struct EnvWarning { pub code: String, pub message: String }
```

PK/식별자는 모두 `String`(기존 project id) — specta i64 금지 규율과 무관(신규 정수 PK 없음).

## 헬스체크 실행 (bounded)

커맨드: `run_connection_audit(db: State<Db>) -> Result<ConnectionAudit, AppError>`
(`src-tauri/src/commands/audit.rs`, lib.rs 등록).

- 프로젝트별 cref 해석 → keychain `has_token` 확인 → 있으면 **단일샷 ping**:
  - github: `api::ping_github` 레시피로 ping하되 **login을 구조적으로 확보**(아래 식별자 참조).
  - notion: `api::ping_notion` + bot/workspace 식별자.
  - notion DB: 바인딩된 id에 한해 `notion::probe_database`(토큰 있을 때만; 없으면 NotConfigured).
  - google/gmail: 기존 connected-status 레시피 재사용(client/refresh 유무 → Ok/Failed/NotConfigured).
- **retry 0**(INVARIANT #5) — 각 ping은 기존 timeout(api.rs 12s 등) 단일 시도.
- **상한 병렬**: 모든 (project×service) 체크 future를 `buffer_unordered(AUDIT_CONCURRENCY=6)`로
  실행. 무상한 fan-out 금지, 최악 wall-clock도 bound.

### 식별자 추출 (계정 중복 판정 입력)

ping 결과 `detail` 문자열을 파싱하지 않고 **구조적으로** 얻는다:
- github: 감사 전용 내부 헬퍼가 `octocrab current().user().login`을 직접 반환(Option<String>).
- notion: `GET /v1/users/me`의 bot/`name`을 직접 반환.

`ConnCheck.detail`에는 사람이 읽을 식별자(예: "GitHub: octocat")만, **계정 중복 판정용 raw login/bot은
별도 내부값**으로 보관해 순수 분석 함수에 넘긴다(렌더러로는 detail 문자열만, raw 식별자도 토큰 아님).

## 중복 + 개인/업무 분리 규칙 (순수 함수, 단위테스트)

`src-tauri/src/commands/audit.rs` 내 순수 헬퍼(네트워크 불필요, fixture 테스트):

- `find_repo_duplicates(repos: &[Repo], projects)`: github는 `parse_owner_repo`로 정규화한
  `owner/repo`, local은 정규화한 `local_path` 기준. 같은 identity가 **2+ 개의 서로 다른 프로젝트**에
  속하면 `DuplicateGroup`.
- `find_notion_db_duplicates(projects)`: 각 프로젝트의 backlog/agenda DB id를 모아 같은 id가 2+
  프로젝트면 그룹(같은 프로젝트의 backlog==agenda 동일 id는 제외).
- `find_account_duplicates(identities)`: (service, identity)별로 프로젝트를 묶어 2+ 프로젝트면
  `AccountDuplicate`. `cross_kind = projects가 Personal과 Work를 모두 포함`. **이게 개인/업무 분리
  핵심 경고** — 같은 GitHub 계정/Notion bot이 개인·업무 프로젝트에 걸쳐 쓰이면 강조.

분석 입력은 (프로젝트 목록 + 레포 목록 + 헬스체크에서 얻은 식별자 맵)뿐 → 네트워크 없이 테스트 가능.

## CLI 환경 검사

- `resolve_cli_bin`을 깨지 않고, **모든 매치 경로를 반환하는** 헬퍼 추가
  (`cli_install_paths(name, known) -> Vec<String>`): 알려진 경로 중 실제 존재하는 바이너리 + PATH
  해석 결과. 2곳 이상이면 `EnvWarning{ code:"cli.gh_multiple_installs"|"cli.ntn_multiple_installs",
  message:"여러 경로에 설치됨: …(우선순위 모호)" }`.
- 순수에 가까움(filesystem stat, 네트워크 0). 경로 목록 입력 기반 판정부는 순수 함수로 테스트.

## UI

- 설정 통합 화면(`SettingsView.tsx`) 상단에 **"연결 점검" 버튼**. 클릭 → `useConnectionAudit`
  (react-query mutation) → 결과 패널 렌더.
- 결과 패널(`components/settings/ConnectionAuditPanel.tsx`):
  - **개인/업무 헤더로 그룹**한 프로젝트별 행, 각 서비스는 ✓(Ok)/✗(Failed)/—(NotConfigured) 칩 +
    `detail` tooltip.
  - 하단 **경고 섹션**: 중복(레포/DB/계정)·환경 경고 목록. `crossKind=true`는 destructive 색 강조 +
    "개인/업무 분리 권장" 문구.
  - 로딩("점검 중…")·에러 인라인. 기존 `StatusDot`/`Badge`/`Card`/`Button` 재사용(새 shadcn
    프리미티브 불요).
- 순수 그룹핑/요약 헬퍼는 `connectionAudit.ts`로 분리해 vitest.

## 구현 슬라이스

1. **백엔드 코어 + 순수 분석**: `models/audit.rs` 타입, `commands/audit.rs`(식별자 추출 +
   `find_*` 순수 함수 + `run_connection_audit` 집계 + `cli_install_paths`), lib.rs 등록. 순수 함수
   단위테스트(repo/db/account 중복 + cross_kind + CLI 멀티설치). bindings 재생성(cargo test).
2. **프런트**: `useConnectionAudit` 훅, `ConnectionAuditPanel` + 순수 `connectionAudit.ts`
   그룹핑/요약 + vitest, `SettingsView`에 버튼/패널 배치.

각 슬라이스: gates(cargo test/clippy/fmt, tc/lint/vitest) green + critic 별도 패스 ACCEPT 후 커밋.
push는 사용자 명시 요청 시에만.

## 테스트 계획

- Rust: `find_repo_duplicates`/`find_notion_db_duplicates`/`find_account_duplicates`(cross_kind
  포함)/CLI 멀티설치 판정 = fixture 단위테스트. 라이브 ping 집계 = 네트워크(기존 ping처럼 사용자
  관찰; 에이전트 실행 불가).
- FE: `connectionAudit.ts` 그룹핑/요약 순수 테스트.
- 라이브 스모크(사용자/cmux): 버튼 클릭 → 전 프로젝트 상태 표시 / 같은 레포를 두 프로젝트에 넣고
  점검 → 중복 경고 / 같은 GitHub 토큰을 개인+업무에 → cross_kind 강조.

## INVARIANT 점검

- 외부 호출·토큰 = Rust 내부, `detail`/raw 식별자에 **토큰 본문 없음**.
- bounded: per-ping timeout + **retry 0** + 병렬 cap.
- `Result<_, AppError>` IPC 경계, AppError 단일 envelope.
- **마이그레이션 0**(읽기 전용 집계, 신규 테이블/컬럼 없음).
- IPC 타입 = tauri-specta 생성(`bindings.ts`), 수기 금지.
- 개인/업무 분리는 판정·표시 모두 백엔드 `kind` 기준(렌더러 추정 없음).

## 리스크 / 트레이드오프

- 프로젝트가 많으면 ping이 다수 → 병렬 cap=6 + 단일샷으로 bound. 그래도 느릴 수 있어 패널에 진행
  표시.
- google/gmail은 라이브 refresh 대신 connected-status로 갈음(비용 절감) — 완전 라이브 검증이
  필요하면 후속에서 ping 경로로 승격 가능(현재 YAGNI).
- 계정 중복은 login/bot 동일성 기준 — 같은 사람이 의도적으로 같은 계정을 여러 개인 프로젝트에 쓰는
  정상 케이스도 그룹으로 표시됨(경고는 cross_kind일 때만 강조, 동종 kind 중복은 정보성).

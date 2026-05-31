# SSOT Governance Harness (Boule) — Design

Date: 2026-05-31
Status: Draft → awaiting user review
Topic: 복잡계 기반 SSOT 자기관찰 거버넌스 하네스를 work-radar 레포에 이식
Source architecture: 사용자 제공 "하네스 구성 지침과 복잡계 기반 SSOT 아키텍처 v1.0"
Reference factory: `../../../../harness` (github.com/revfactory/harness — team-architecture factory)

> Working name **Boule** (아테네 평의회). 이름은 bikeshed — 자유 변경.

---

## 0. Problem & Framing

사용자의 복잡계 기반 SSOT 아키텍처(Events→Patterns→Hypotheses→Decisions→Principles
5계층 + 7개 시간-스케일 자율 에이전트 + 4 피드백 루프)를, **work-radar 레포 자체를
관장하는 거버넌스 하네스**로 이식한다.

확정된 스코프 결정(브레인스토밍 Q&A):

1. **이식 대상 = work-radar 레포** (harness는 factory/참조로만 사용).
2. **관장 대상 = 개발 메타-거버넌스** — work-radar를 _어떻게 만드는가_(결정/패턴/원칙)를
   관장한다. 제품 런타임 신호(signals/agent_runs)는 대상 아님.
3. **인프라 깊이 = 원문 충실(풀 인프라)** — Postgres+pgvector 인덱스, 에이전트 버스,
   7 에이전트, 구조화 로그, 백업/재구축. 단 **Telegram → Hermes로 대체**.
4. **그래프트 구조 = 하이브리드(C)** — harness 6-패턴 어휘로 에이전트 팀을 설계 + 풀
   사이드카 인프라 + work-radar 기존 거버넌스(decision-rails/adr) 재조정.
5. **인터페이스 = Governance MCP 서버 + Hermes 패널** (문서 §6.3 ask_user/send_file 충실).

### 0.1 왜 이 그래프트가 자연스러운가

work-radar는 이미 거버넌스 spine을 갖고 있고, SSOT 5계층이 거의 1:1로 안착한다.
새 평행 시스템을 짓는 게 아니라 **빠진 계층(Events/Patterns/Hypotheses)을 채우고
자율 피드백 루프를 기존 spine에 배선**하는 일이다. 이는 AGENTS.md의 "가장 작은 변경 /
기존 패턴 재사용 / 중복 금지" 규율과 정합한다.

재귀적 우아함: work-radar(업무 레이더)를 닮은 시스템이 work-radar가 만들어지는 과정을
관찰한다.

---

## 1. Layer Mapping — Adopt-in-place, Don't Duplicate

L3/L4는 **이미 존재하는 정본 파일을 재사용**하고, 없는 계층(L0/L1/L2)만 신규 저장한다.

| Layer             | 성격            | Realization (work-radar)                                                        | 수정 권한                                  |
| ----------------- | --------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| **L4 Principles** | 헌법            | **정본 = `docs/areas/decision-rails.md`** (7 INVARIANTS)                        | 사람 승인 필수 (Meta Observer가 PR로 제안) |
| **L3 Decisions**  | 확정 약속       | **정본 = `docs/adr/`(Type 1, 비가역) + `docs/decisions.md`(Type 2/Phase 로그)** | Type 1 항상 사람; Type 2 자동 가능         |
| **L2 Hypotheses** | 검증 가능 가설  | **신규** → `governance/workspace/hypotheses/`                                   | 에이전트 제안, 사람 승인(원칙 반영 시)     |
| **L1 Patterns**   | 반복 관찰 압축  | **신규** → `governance/workspace/patterns/`                                     | 에이전트 자동 (활성화는 사람 검토)         |
| **L0 Events**     | append-only raw | **신규** → `governance/workspace/events/`                                       | 시스템(Gateway) + 사람 직접                |

### 1.1 L0 Event 소스 — work-radar가 이미 방출하는 것

신규 계측 거의 없이 Gateway가 수확:

- **git 커밋** (post-commit 훅 또는 폴링) → `commit_recorded`
- **PR 이벤트** (기존 `src-tauri/src/github.rs` 경로 재사용) → `pr_opened` / `pr_merged` / `ci_failed`
- **codex/Hermes `AgentRun` 완료** (기존 AgentRun 모델, engine: codex|hermes|claude) → `agent_run_completed`
- **`docs/decisions.md` 신규 라인** (append 감지) → `decision_recorded` (Type 2)
- **`docs/adr/` 신규 파일** → `decision_proposed` (Type 1 후보)
- **Hermes 대화의 명시적 명령** (`/task` 등) → 해당 event

### 1.2 Type 1 / Type 2 — work-radar 규율과 일치

- **Type 1 (비가역)** = 새 ADR / INVARIANT 변경. work-radar는 _이미_ 이에 대해 외부
  리뷰 + self-approve 금지를 요구한다 → Type 1 Guardian이 이 규칙을 **기계화**.
- **Type 2 (가역)** = `docs/decisions.md`의 Phase 트레이드오프 한 줄 → 자동 진행 가능.

---

## 2. Storage & Directory Layout

새 self-contained 사이드카 (Tauri 빌드 비포함):

```
governance/
  workspace/                  # git-tracked markdown SSOT (문서 §3.4)
    events/  YYYY-MM-DD/HH-MM-SS_<type>.md      # L0, append-only immutable
    patterns/  active/ archived/                # L1
    hypotheses/ testing/ archived/              # L2
    reviews/                                    # External Reviewer 산출물
    state/                                      # 재생성 가능 캐시 view
    agents/  *.md                               # 7 에이전트 명세서 (SSOT의 일부)
    interfaces/
      MCP.md                                    # Governance MCP 명령/도구 명세
    # decisions/  → POINTER: ../../docs/adr + ../../docs/decisions.md (복제 안 함)
    # principles/ → POINTER: ../../docs/areas/decision-rails.md       (복제 안 함)
  services/
    bus/        # 이벤트 라우팅 + 에이전트 호출 조정
    agents/     # 7 에이전트 런너 (시간 스케일별 스케줄)
    mcp/        # Governance MCP 서버 (ask_user, send_file, 명령셋)
    index/      # Postgres+pgvector ingest + rebuild-from-markdown 스크립트
  docker-compose.yml   # Postgres + pgvector (재구축 가능 인덱스; markdown이 SSOT)
  README.md
```

**핵심 규칙(문서 §3.2):** 쓰기는 항상 markdown 먼저, 인덱스는 그 뒤(비동기). 인덱스
손상 시 markdown에서 완전 재구축. `services/index/rebuild.*`가 시스템 구성 요소.

### 2.1 Event / Pattern / Hypothesis 파일 형식

문서 §2.2–2.4 그대로 (YAML frontmatter + Markdown 본문). 예: event 필수 필드
`id, type, source, actor, tags`; pattern `evidence_count, confidence, status`;
hypothesis `from_pattern, status, test_method, baseline, expires`.

### 2.2 Decisions/Principles 어댑터

L3/L4는 신규 디렉토리를 만들지 않고 **어댑터**가 기존 파일을 SSOT 인터페이스로 노출:

- `services/index`는 `docs/adr/*.md` 와 `docs/decisions.md`, `decision-rails.md`를
  파싱해 Postgres에 decision/principle 로우로 ingest (참조 그래프/`/why`/`/history` 지원).
- 쓰기는 절대 자동 아님 — Meta Observer/Guardian은 **PR 초안**만 생성.

---

## 3. Agents (문서 §4.4, 레포 거버넌스로 스케일)

각 에이전트는 `governance/workspace/agents/<name>.md` 명세서(문서 §4.2 형식)로 정의.
권한 = 명세서에 선언된 경로만 쓰기(문서 §4.5).

| Agent                 | 스케일    | 역할                                                         | 쓰기 경로          |
| --------------------- | --------- | ------------------------------------------------------------ | ------------------ |
| **Gateway**           | 즉각      | 레포 활동 → L0 events                                        | `events/`만        |
| **Type 1 Guardian**   | 즉각      | `decision_proposed`(Type 1) 가로채 외부검증+사람 게이트 강제 | (차단/보고만)      |
| **External Reviewer** | Type 1 시 | 작성자와 **다른 모델** 적대적 검토                           | `reviews/`만       |
| **Pattern Detector**  | 6h        | L0 스캔 → L1 (pgvector 유사도)                               | `patterns/`만      |
| **Hypothesis Tester** | 일        | testable L2 평가 → verified/refuted                          | `hypotheses/`만    |
| **Meta Observer**     | 주        | L1+verified-L2 → `decision-rails.md`(L4) 진화 **PR 제안**    | (PR 초안만)        |
| **Archive Pruner**    | 월        | stale events/patterns/expired hyp → archive                  | `*/archived/` 이동 |

harness 6-패턴 어휘로 팀 구조화:

- **Producer-Reviewer**: Type 1 Guardian ↔ External Reviewer
- **Pipeline**: Events → Patterns → Hypotheses
- **Supervisor**: Meta Observer (가장 느린 스케일, 전체 관찰)
- **Expert Pool**: 시간-스케일별 에이전트 분산

### 3.1 런너 & 스케줄

- 즉각(Gateway/Guardian): 이벤트 트리거 (git 훅 / 파일 워처 / MCP 호출).
- 6h/일/주/월: cron 기반 사이드카 스케줄러 (`services/agents` 진입점이 Claude Code
  에이전트를 `claude -p` 또는 SDK로 호출).
- **bounded retry only**(INVARIANT #5): backoff+jitter, terminal failure 노출, 무한 poll 금지.
- 구조화 JSON 로그(문서 §7.1) 1일차부터. heartbeat age 메트릭.

---

## 4. Feedback Loops (문서 §5)

4개 명시적 루프 전부 배선:

1. **학습 루프**: decision → (30~90일) Meta Observer가 결과 측정 → hypothesis 갱신.
2. **적응 루프**: Pattern Detector 발견 → Hermes로 사람 알림 → 승인 → decision-rails
   업데이트 → Guardian이 새 INVARIANT 자동 로드.
3. **정합성 루프**: 새 decision이 기존 principle과 충돌 → Guardian 차단+충돌 보고 →
   사람 선택(폐기/원칙 진화) → 선택 자체가 event 기록.
4. **망각 루프**: Archive Pruner 월 1회 → stale 이동 → state/ 캐시 재계산 → 인덱스 재구축.

---

## 5. Interface — Governance MCP + Hermes 패널 (Telegram 대체)

### 5.1 Governance MCP 서버 (`services/mcp/`)

문서 §6.2 명령셋 + §6.3 두 도구를 MCP 도구로 노출:

- 명령: `create_task`(/task), `status`, `observations`, `hypotheses`, `principles`,
  `conflicts`, `why <id>`, `history <id>`, `approve <id>`, `reject <id>`.
- UI 도구: `ask_user`(탭 가능한 선택지 제시), `send_file`(산출물 채팅 전송).

### 5.2 Hermes 패널 = 사람 surface

work-radar의 기존 Hermes ACP 플로팅 패널(`src-tauri/src/hermes_agent/`,
`HermesView.tsx`)을 재사용:

- Hermes acp 세션이 Governance MCP를 로드 → governance 명령이 ACP
  `available_commands`로 자동 등장 → `HermesSlashMenu`에 노출.
- **승인 게이트 = 인터랙티브 카드**: 문서의 "tappable buttons"를 패널 내 shadcn
  버튼으로 렌더. 신규 이벤트 `hermes-agent:ask-user { options }` + 응답 IPC
  `hermes_ask_user_respond(choice)` 추가 (기존 §4.3 이벤트 패턴 확장).
- `send_file` → 패널 첨부/렌더.
- **Telegram 미사용.** `messenger.rs` Telegram 브릿지는 직교 — 건드리지 않음.

### 5.3 work-radar IPC 추가분

신규 work-radar 커맨드/이벤트는 전부 **specta 생성 타입**(INVARIANT #4):
`hermes-agent:ask-user` 이벤트, `hermes_ask_user_respond` 커맨드. `bindings.ts`
drift = CI 게이트.

---

## 6. INVARIANT Compliance (decision-rails — 리뷰 바)

| #   | INVARIANT                    | 준수 방법                                                                                                                               |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | 에이전트는 **제안만**(draft event / PR). Type 1·Principle은 **항상** 사람 게이트. 아키텍처의 자체 게이트가 invariant를 *기계화*해 강화. |
| 2   | 외부 토큰 keychain           | Postgres 자격증명 keyring 경유. Telegram 토큰 자체가 없음. Hermes는 자기 auth 관리.                                                     |
| 3   | 외부 네트워크 Rust           | governance 서비스는 로컬(버스/Postgres). git/PR은 기존 `github.rs` 경로. 렌더러 토큰 노출 없음.                                         |
| 4   | IPC = specta 생성            | 신규 work-radar 커맨드/이벤트 specta annotated, bindings drift CI 게이트.                                                               |
| 5   | bounded retry                | 런너 backoff+jitter+terminal failure 노출, 무한 poll 금지.                                                                              |
| 6   | SQLite 마이그레이션만        | governance는 **별도 Postgres** — 앱 sqlite 무변경(ad-hoc ALTER 없음).                                                                   |
| 7   | 시각 디자인 DESIGN.md        | Hermes 패널 추가 UI는 shadcn 위 + Tailwind v4 토큰.                                                                                     |

INVARIANT 검증은 **별도 reviewer 패스**(critic/code-reviewer) — self-approve 금지.

---

## 7. Security Model (문서 §8, 적용분)

- **경로 제한**: 각 에이전트는 명세서 선언 경로 외 쓰기 금지(ALLOWED_PATHS).
- **권한 우회 비대상**: Type 1 결정, `principles`(decision-rails) 쓰기, 외부 영향 행위,
  ALLOWED_PATHS 외부 — 항상 게이트.
- **프롬프트 인젝션**: Gateway가 외부 입력을 시스템 명령으로 해석 금지(명시적 구분).
  각 에이전트는 명세서 선언 도구만.
- **이중 검증**: Type 1은 2개 이상 독립 모델 검토.
- **로그 PII/시크릿 금지**(INVARIANT 정합): 프롬프트/응답 본문 로그 X, 길이·id·tool명만.

---

## 8. Phasing (문서 §9, 1:1) — 종료 조건 = 관찰 증거

| Phase                    | 목표                            | 범위                                                                                  | Done-criteria (관찰)                                |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **P1 기초 골격**         | Events + 최소 Hermes 인터페이스 | workspace 레이아웃, Gateway, Governance MCP 골격(몇 개 명령)                          | 레포 활동이 event로 일관 기록됨                     |
| **P2 의사결정 거버넌스** | Decisions + Type 1/2            | adr/decisions.md 어댑터, Type 1 Guardian, External Reviewer, 사람 게이트(Hermes 카드) | Type 1(새 ADR)이 외부검증 없이 자동 실행 안 됨      |
| **P3 패턴 발견**         | Patterns + 인덱스               | Pattern Detector, Postgres+pgvector, rebuild 스크립트                                 | 발견 패턴을 사람이 정기 확인                        |
| **P4 가설 검증**         | Hypotheses                      | Hypothesis Tester, 검증 추적                                                          | ≥1 가설 verified/refuted → decision 반영            |
| **P5 메타 관찰**         | Principles 진화                 | Meta Observer, decision-rails 진화 PR 워크플로                                        | 발견 패턴이 ≥1 INVARIANT 변경으로 이어짐(사람 승인) |
| **P6 망각·정합성**       | 장기 운영 정리                  | Archive Pruner, 정합성 점검 도구                                                      | 6개월+ 운영에도 SSOT 검색 가능 크기 유지            |

각 Phase done-criteria는 **실제 실행/관찰**로 채운다(체크박스 = 증거). 점진 도입 —
막히는 지점에서만 다음 계층 추가(문서 §9 권장).

---

## 9. Observability & Ops (문서 §7)

- 구조화 JSON 로그(§7.1) 1일차부터.
- 헬스 메트릭(§7.2): events/day, patterns_active, hypotheses_testing,
  type1_block_rate, principle_modifications/month, agent_heartbeat_age_max.
- 백업: git remote 자동 푸시(markdown) + 외부 스토리지 일 1회 스냅샷.
- 인덱스 재구축: markdown만으로 Postgres+pgvector 완전 재생성 가능(스크립트가 구성 요소).
- 비용(§7.4): 빠른 스케일 저비용 모델 / 느린 스케일 고성능; 프롬프트 캐싱; tool 출력
  truncate(원본 해시 참조); 컨텍스트 70% 압축.

---

## 10. Distribution Plan (사용자 "omc-teams로 분배")

> ⚠️ `/omc-teams`(CLI tmux 런타임)는 이 환경(cmux)에서 startup 스톨 이력 → 기본은
> **네이티브 병렬 에이전트**(동일 분업, 스톨 없음). 사용자가 CLI 런타임을 고집하면 omc-teams.

플랜 승인 후 레인 분배:

- **infra** ∥ docker-compose/Postgres/pgvector/rebuild 스크립트
- **ssot+agents** ∥ workspace 레이아웃 + 버스 + 7 에이전트 명세/런너
- **interface** ∥ Governance MCP 서버 + Hermes ask-user 카드/IPC
- **reconciliation** ∥ adr/decisions.md/decision-rails 어댑터 + 매핑
- → **critic/verifier** (INVARIANT 패스, 별도 컨텍스트, self-approve 금지)

병렬 격리 주의(parallel-agent-safety): worktree 격리 에이전트 교차오염 이력 →
순차 또는 명확한 경로 분리. executor late-writes → 커밋 전 git status.

---

## 11. Risks / Open Questions

- **사이드카 운영 부담**: Postgres+버스+스케줄러 상시 가동. 풀 인프라 선택의 비용 —
  P1에서는 인덱스 없이 markdown만으로 시작, P3에서 Postgres 도입(점진).
- **Hermes MCP 로딩 경로**: Nous Hermes Agent CLI(ACP)가 외부 MCP 서버를 어떻게
  로드/노출하는지 P1 진입 시 실측 필요(acp `available_commands`로 governance 명령이
  뜨는지). 안 되면 5.2 폴백 = 네이티브 IPC 인터셉트(브레인스토밍 대안 옵션).
- **decision-rails 쓰기 충돌**: Meta Observer PR이 사람 편집과 경합 가능 → PR-only +
  사람 승인으로 직렬화.
- **이중 정본 드리프트**: L3/L4 어댑터가 adr/decisions.md/decision-rails를 인덱싱하되
  쓰기는 PR-only — markdown이 항상 정본, Postgres는 파생.
- **work-radar 빌드 영향 0 보장**: governance/는 Tauri/Vite 빌드 그래프 밖. CI에 별도
  레인(또는 제외) 명시.

---

## 12. Verification (work-radar 정본 명령 — `docs/reference/commands.md`)

- governance 서비스: 자체 단위 테스트(이벤트 ingest, 패턴 탐지, rebuild 멱등성).
- work-radar 변경분(Hermes IPC): `cargo test` + `cargo clippy --all-targets -- -D warnings`
  - `cargo fmt --check`; `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`;
    `pnpm bindings:check`(specta drift 0); `pnpm tauri dev` 부팅.
- INVARIANT 7개: 별도 critic 패스로 위반 여부 확인(self-approve 금지).
- 실행 못 한 검증은 명시적으로 "could not run" ≠ "passed".

---

## 13. 용어 (문서 §10.1 발췌)

SSOT, Event(불변 사실), Pattern(반복 구조), Hypothesis(검증 가능 추론),
Decision(확정 약속), Principle(헌법적 메타규칙), Type 1(비가역, 외부검증+사람 필수),
Type 2(가역, 자동 가능), 창발, 경로 의존성. 상세는 원문 §10.

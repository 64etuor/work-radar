# Harness Routing + Design Rigor 정리 플랜

**Date:** 2026-05-26
**Status:** DRAFT — 사용자 승인 게이트 (Part 1 PR-H1 머지 전까지 다른 PR 미진행)
**Source agents:** Phase A (opus, harness 설계) + Phase B1 (sonnet, Rust 감사) + Phase B2 (sonnet, Frontend 감사)
**Source artifacts (drafts):**
- `.omc/research/harness-design/area-map.md` (centerpiece)
- `.omc/research/harness-design/{claude,agents}-md.draft.md`
- `.omc/research/harness-design/extracted/*.md` (10개 area docs)
- `.omc/research/harness-design/gap-report.md` (auto-memory 17건 커버리지)
- `.omc/research/audit-rust.md`
- `.omc/research/audit-frontend.md`

---

## TL;DR

1. **하네스 라우팅 도입** = work-radar의 1순위. Mirrorless_Mono 패턴 (root CLAUDE.md = thin router + AGENTS.md = 레포 전역 working agreement + `docs/areas/area-map.md` = 라우팅 테이블 + `docs/areas/<area>.md` = 도메인 규율)을 단일-패키지 형태로 적용.
2. **God-code 리팩터**는 라우팅 도입 **이후**에 영역별로. 그래야 각 PR이 단일 area 문서만 로드하면서 진행됨.
3. **실제 INVARIANT 위반은 2건만 발견** — `commands/notion.rs:478` 인라인 `reqwest::Client` (레이트리미터 우회) + `EnrichModal/EnrichReviewPanel` `setInterval` 직접 IPC.
4. **네이밍 결정**: PascalCase 컴포넌트 + camelCase util (확인됨). 3개 파일만 rename.

---

## Part 1 — 하네스 라우팅 (PR-H1, 1순위, **승인 게이트**)

**Scope:** 문서만 변경. 코드 무관.

### 변경 내역

| 액션 | 파일 | 출처 |
|---|---|---|
| **NEW** | `docs/areas/area-map.md` | `.omc/research/harness-design/area-map.md` |
| **REPLACE** | `CLAUDE.md` (현 41 lines → 36 lines, thin router) | `.omc/research/harness-design/claude-md.draft.md` |
| **REPLACE** | `AGENTS.md` (현 ~65 lines, 도메인 규율 인라인 → ~140 lines working agreement + Important Paths index) | `.omc/research/harness-design/agents-md.draft.md` |
| **NEW** | `docs/areas/decision-rails.md` (PLAN.md §1 INVARIANTS 추출) | extracted/decision-rails.md |
| **NEW** | `docs/areas/ipc-conventions.md` | extracted/ipc-conventions.md |
| **NEW** | `docs/areas/data-layer-conventions.md` | extracted/data-layer-conventions.md |
| **NEW** | `docs/areas/shadcn-migration.md` | extracted/shadcn-migration.md |
| **NEW** | `docs/areas/frontend-board.md` | extracted/frontend-board.md |
| **NEW** | `docs/areas/frontend-shell.md` | extracted/frontend-shell.md |
| **NEW** | `docs/areas/news-feature.md` | extracted/news-feature.md |
| **NEW** | `docs/areas/parallel-agent-safety.md` | extracted/parallel-agent-safety.md |
| **NEW** | `docs/areas/shell-tooling.md` | extracted/shell-tooling.md |
| **NEW** | `docs/areas/git-conventions.md` | extracted/git-conventions.md |
| **EDIT** | `PLAN.md` — §1 INVARIANTS 섹션을 1줄 포인터로 (`→ docs/areas/decision-rails.md`) | — |
| **EDIT** | `docs/decisions.md` — 한 줄: "2026-05-26: 하네스 라우팅 도입(`docs/areas/area-map.md`), AGENTS.md slim, INVARIANTS → `docs/areas/decision-rails.md`. Rationale: 도메인별 로드. Mirrorless_Mono 패턴 인용." | — |

### 결정 (Phase A open questions 해소)

| 질문 | 결정 | 사유 |
|---|---|---|
| area-map 경로: `docs/architecture/` vs `docs/areas/` | **`docs/areas/area-map.md`** | sibling area docs와 일관성. Mirrorless는 monorepo여서 `docs/architecture/package-map.md`였음. work-radar는 단일 패키지여서 area-anchored가 자연. |
| `news-feature.md` 크기 (4.4K, state 중심) | **유지 — full doc** | 로드는 on-demand. 크기는 도메인 안에서만 부담. 상태가 흘러도 area 안에서. |
| `shadcn-migration.md` ↔ `docs/plans/2026-05-24-shadcn-app-wide-migration.md` | **plan 유지, area는 distilled durable만** | plan은 historical record, area는 durable rules. area에서 plan 인용. |
| `claude-md.draft.md` 36줄 vs Mirrorless 33줄 | **36줄 keep** | 한국어 표현 차이 + 빠른 라우팅 라인 보존. 가독성 우선. |
| `ipc-conventions.md` ↔ 기존 `docs/reference/error-handling.md` | **별도 유지** + ipc-conventions.md에서 포인터 | reference는 명령/패턴 인덱스, area는 작업 가드. 역할 다름. |

### Done-criteria

- [ ] `docs/areas/` 디렉토리에 11개 파일 (`area-map.md` + 10 extracted) 존재
- [ ] root `CLAUDE.md` ≤ 40줄, `@AGENTS.md` + 빠른 라우팅 + 4섹션만
- [ ] root `AGENTS.md`에서 shadcn 마이그레이션 단락, 기술 스택 나열, news 규칙, DESIGN.md 반복 모두 **제거** (전부 area docs로 이동했는지 grep 확인)
- [ ] `PLAN.md` §1이 1줄 포인터로 축약 (Phase 계획만 남음)
- [ ] `docs/decisions.md` 1줄 추가
- [ ] gap-report.md의 17 incidents 모두 적어도 하나의 area doc에 커버됨 (`gap-report.md` 끝 coverage 테이블)

### 검증

- [ ] `pnpm typecheck` (영향 없음 — 문서만)
- [ ] 새 area docs에서 깨진 링크 없음 (수동 grep)
- [ ] reviewer 패스 (critic 등) — self-approve 금지

### 사용자 승인 게이트

PR-H1 머지 전 사용자가 다음을 확인:
1. `docs/areas/area-map.md` 라우팅 테이블이 실제 작업 패턴과 일치하는가
2. `AGENTS.md`에서 빠진 항목 중 빠뜨리면 안 되는 것이 없는가
3. extracted area docs의 내용이 정본으로 채택할 만한 정확도인가

이 게이트 통과 전 Part 2/3/4 미진행.

---

## Part 2 — 실제 INVARIANT 위반 수선 (PR-R-Notion, PR-F-Enrich)

**감사 결과 실제 위반은 2건. 가장 먼저 고친다.**

### PR-R-Notion — `commands/notion.rs:478` 인라인 reqwest 제거

**문제:** `test_notion_connection`이 `HttpNotionWriter`를 우회해 inline `reqwest::Client`를 빌드 → 레이트리미터 우회 + HTTP 구성 중복.

**변경:**
- `commands/notion.rs::test_notion_connection`이 `HttpNotionWriter::test_connection(db_id, token)` (notion.rs에 신설)을 호출하도록 수정
- 인라인 `reqwest::Client` 코드 제거

**Done:**
- [ ] `rg 'reqwest::Client::builder' src-tauri/src/commands/` → 0 매치
- [ ] `cargo test notion::` (기존 + test_connection 신규 테스트 추가)
- [ ] `cargo clippy --all-targets -- -D warnings`

### PR-F-Enrich — `EnrichModal`/`EnrichReviewPanel` setInterval 폐기

**문제:** 두 컴포넌트 모두 `setInterval` + `commands.agentRunStatus()` 직접 호출 → TanStack Query 레이어 우회 → AGENTS.md INVARIANT 위반 (IPC는 query 레이어를 거쳐야 함).

**변경:**
- `src/lib/query/agents.ts`에 `useAgentRunStatus(runId, { enabled, refetchInterval })` 추가 — `staleTime: 0`, `refetchInterval: 2000`, `enabled`로 폴링 ON/OFF
- 두 컴포넌트가 이 hook으로 마이그레이션
- `setInterval` 제거

**Done:**
- [ ] `rg "setInterval.*agentRunStatus" src/` → 0 매치
- [ ] `rg "invoke\(" src/components/board/Enrich*` → 0 매치
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`

---

## Part 3 — 네이밍 표준화 (PR-Naming, 단일 atomic)

**결정 채택:** PascalCase 컴포넌트 + camelCase util. shadcn `src/components/ui/**` kebab-case는 예외(유지).

### Rename 목록

| 현재 | 새 이름 | 사유 |
|---|---|---|
| `src/lib/skill-grouping.ts` | `src/lib/skillGrouping.ts` | util은 camelCase. (`agentBar.ts`/`newsTicker.ts`/`worktreeReview.ts`와 일관) |
| `src/components/board/board-utils.ts` | `src/components/board/boardUtils.ts` | board/는 ui/ 아님 — util 컨벤션 적용 |
| `src/components/settings/kit.tsx` | `src/components/settings/SettingsKit.tsx` | 컴포넌트는 PascalCase |

### 변경

- 3 파일 git mv
- 모든 import 경로 일괄 업데이트 (`rg -l "skill-grouping"` 등으로 찾아서)
- 테스트 파일 동반: `skill-grouping.test.ts` → `skillGrouping.test.ts` (있다면)

### Done

- [ ] `pnpm typecheck` (import 경로 깨짐 없음)
- [ ] `pnpm lint`
- [ ] `pnpm vitest run`
- [ ] grep 후행 잔존 매치 0건

### 비-스코프 (의도적)

- `src/components/ui/` kebab — shadcn 컨벤션, 유지
- 기존 PascalCase 컴포넌트 / camelCase util 전체 — 위반 없음

---

## Part 4 — Rust God-Code 분할 (PR-R-Calendar, PR-R-Models, PR-R-CalendarLeak)

**Priority H/M만 진행. L은 백로그.**

### PR-R-Models (Priority M, 선행) — `models.rs` (1296 LOC) → 도메인별 facade

가장 안전 (rename 전용). 다른 PR의 임팩트를 줄이기 위해 먼저.

**변경:**
- 14 도메인 그룹을 식별 (audit-rust.md §models.rs special analysis 참조)
- 각 그룹을 해당 도메인 모듈로 이동 (예: signal-related → `signal.rs`, agent-related → `agent.rs`, notion-related → `notion.rs`, …)
- `models.rs`는 한동안 `pub use` 재-export facade로 유지 (호환성)
- 그 후 점진적 import 직접화 (별도 follow-up)

**Done:**
- [ ] `models.rs` ≤ 200 LOC (facade만)
- [ ] `cargo test` 전체 그린
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] frontend `bindings.ts` drift 0 (이동만, 타입 변경 없음)

### PR-R-CalendarLeak (Priority M) — `calendar.rs` ↔ `commands/calendar.rs` 도메인 누수 수선

**변경:** `commands/calendar.rs`의 다음을 `calendar.rs`로 이동
- `access_token_for` (creds load + refresh + write)
- `fetch_events_windowed` (orchestration)
- `apply_calendar_urgency`, `parse_quadrant_hint` (순수 도메인 분류)

`OnceLock<TtlCache>` 캐시 싱글톤은 commands/에 유지 (앱 lifecycle state).

**Done:**
- [ ] `commands/calendar.rs` ≤ 250 LOC (thin IPC handlers)
- [ ] `cargo test calendar::`
- [ ] `cargo clippy -D warnings`

### PR-R-Calendar (Priority H) — `calendar.rs` (1432 LOC) → 6 slice

**변경:** (audit-rust.md의 제안 그대로)
- `calendar/oauth.rs` (PKCE, creds serialize)
- `calendar/loopback.rs` (TCP accept)
- `calendar/parse.rs` (list + event parse)
- `calendar/windows.rs` (time window helpers)
- `calendar/http.rs` (HttpCalendarProvider)
- `calendar/write.rs` (event write)
- `calendar/mod.rs` (`CalendarProvider` trait + facade)

PR-R-CalendarLeak 머지 **후** 진행.

**Done:**
- [ ] 6 슬라이스 각 ≤ 400 LOC, mod.rs ≤ 200 LOC
- [ ] `cargo test calendar::`
- [ ] `cargo clippy -D warnings`
- [ ] OAuth 통합 스모크 (수동, 1회): 새 Google Calendar 연결 성공

### 백로그 (이 플랜 스코프 외)

- `commands/notion.rs` 도메인 추출 (`execute_promotion`/`resolve_notion_target`/`flush_inner` → `notion/promotion.rs`) — PR-R-Notion **이후**에 별 PR
- 그 외 Priority L 파일 (git.rs, messenger.rs, agent.rs, signal_store.rs 등) — 현재 god이지만 layering 클린. 변경 빈도 보고 결정.

---

## Part 5 — Frontend God-Component 분할 (PR-F-Worktree, PR-F-Jobs, PR-F-Capture)

### PR-F-Worktree (Priority H) — `WorktreeView.tsx` (1575 LOC) → 9 파일

**변경:** (audit-frontend.md의 제안 그대로)
- `src/lib/useStickyToggle.ts` (~20 LOC)
- `src/components/worktree/WorktreeView.tsx` (~250 LOC, shell)
- `src/components/worktree/WorktreeSideList.tsx` (~80)
- `src/components/worktree/WorktreeReviewPanel.tsx` (~120)
- `src/components/worktree/WorktreeFileList.tsx` (~130)
- `src/components/worktree/WorktreeDiffText.tsx` (~170)
- `src/components/worktree/CommitGraphDrawer.tsx` (~310, SVG topology)
- `src/components/worktree/CleanupPanel.tsx` (~130)
- `src/components/worktree/RebaseBar.tsx` (~65)

**Risk gate:** `GraphCanvas` 데이터 흐름 (topology → SVG) 보존 필수. 추출 후 시각 동등성 수동 확인.

**Done:**
- [ ] 새 파일 9개, 각 LOC 추정치 ±20%
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`
- [ ] `pnpm tauri dev` 부팅 → Worktree 뷰 진입 → CommitGraph drawer 열기/닫기 정상
- [ ] cmux Esc 스모크 (drawer)

### PR-F-Jobs (Priority H) — `JobsView.tsx` (838 LOC) → 4 패널

**변경:**
- `src/components/jobs/SelfCheckPanel.tsx`
- `src/components/jobs/EnrichPanel.tsx`
- `src/components/jobs/BatchEnrichPanel.tsx`
- `src/components/jobs/TriagePanel.tsx`
- `src/components/jobs/JobsView.tsx` (~200 LOC shell)
- `src/components/jobs/jobsConstants.ts` — `QUADRANT_OPTS`/`AREA_OPTS` 추출 (EnrichModal.tsx 중복 제거 동반)

**Done:**
- [ ] EnrichModal.tsx의 `QUADRANT_OPTS`/`AREA_OPTS` 중복 제거 → 신설 상수 import
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`
- [ ] Acceptance 게이트 4종 수동 스모크

### PR-F-Capture (Priority H) — `CaptureBoard.tsx` (624 LOC) → useCaptureActions hook

**변경:**
- `src/components/board/useCaptureActions.ts` (~250 LOC) — 19 mutation hooks + handleNotionPromote/handleEnrichAll/handleMenuAction 추출
- `CaptureBoard.tsx` (~350 LOC) — keyboard / online-flush / calendar-urgency / pop-animation effects + 렌더링만 잔존

**Done:**
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`
- [ ] cmux 스모크: 카드 promote/enrich/menu 액션 모두 동작
- [ ] **MatrixCanvas / CalendarDrawer / BrainDumpToggle 무변경** (frontend-board.md protected list)

### 백로그 (이 플랜 스코프 외)

- `NewsSourceSettings.tsx` (Priority M)
- `MatrixCanvas.tsx` (Priority M — `frontend-board.md`가 "protected" 표시. 함부로 분할 금지)
- `AgentStatusBar.tsx` (Priority M)

---

## Part 6 — CSS dead-block 정리 (PR-F-CSS-Dead)

작은 isolation PR.

**변경:**
- `src/styles.css` 라인 3963–4065 (`.asb-seg*`, `.asb-track`, `.asb-count`, `.asb-kind-label`, `.asb-cmux-chip` — 약 65 LOC) 제거. P10a AgentStatusBar 박스 리디자인 이후 stranded.
- 8개 raw 뉴스 소스 브랜드 색 (`#ff6600`, `#1f7a8c` 등)을 `@theme` 토큰으로 (선호: `--color-news-brand-{slug}` 또는 컴포넌트에서 인라인 유지 결정 — 결정 필요. **권장:** Tailwind v4 `@theme`에 `--news-brand-*` 토큰 추가)

**Done:**
- [ ] 각 제거 클래스가 TSX에서 미참조 (grep 확인)
- [ ] `pnpm typecheck` + `pnpm lint`
- [ ] 시각 회귀 없음 (수동: AgentStatusBar / News sources 화면)

---

## 실행 순서 (제안)

```
Day 0: PR-H1 (하네스) — 사용자 승인 게이트 ★
  ↓ (승인 후)
Day 1: PR-R-Notion (INVARIANT 위반 1) + PR-F-Enrich (INVARIANT 위반 2)
       + PR-Naming (3 파일 rename)
  ↓
Day 2: PR-R-Models (재-export facade) — 안전한 선행
  ↓
Day 3: PR-R-CalendarLeak → PR-R-Calendar
  ↓
Day 4: PR-F-Worktree → PR-F-Jobs → PR-F-Capture (의존 X, 병렬 가능하지만 cmux 스모크 부담 ↑)
  ↓
Day 5: PR-F-CSS-Dead
```

**각 PR마다:**
- 단일 관심사 (`AGENTS.md` "한 PR = 한 관심사")
- PR 본문: 문제 / 변경 / 검증 명령 출력 / INVARIANT 체크 / 의도적 deferred
- `docs/decisions.md` 한 줄
- 별도 reviewer/critic 패스 (self-approve 금지)

---

## 비-스코프 (의도적 제외)

- Rust Priority L 파일 (git.rs, messenger.rs, agent.rs, signal_store.rs, news/store.rs 등) — 모두 god 사이즈지만 layering 클린, 변경 빈도 낮음. 백로그.
- styles.css 전체 분해 — dead block 정리만, 5360 → ~5295 LOC. 전면 분해는 별도 플랜.
- 새 도메인 doc 추가 — Part 1 11개로 시작, 추후 incident 발생 시 추가.
- TanStack Query persist 패턴 변경 — 별도.

---

## 변경 임팩트 요약

| 영역 | 변경 종류 | LOC delta(추정) |
|---|---|---|
| Harness docs | +11 area docs, AGENTS.md slim, CLAUDE.md slim, PLAN.md §1 축약 | +60K(문서) / 코드 0 |
| Rust 도메인 누수 | 2 PR (Notion 인라인 reqwest, calendar leak) | ±0 (이동) |
| Rust god split | 2 PR (models facade, calendar 6 slice) | ±0 (이동) |
| Frontend god split | 3 PR (Worktree 9, Jobs 4+const, Capture hook) | ±0 (이동) |
| Frontend IPC 위반 | 1 PR (useAgentRunStatus 신설) | +~40 / -~20 |
| Naming | 1 PR (3 rename) | ±0 |
| CSS | 1 PR (~65 dead + 토큰화) | -~65 / +~10 (토큰) |

**총 10 PR**, 모두 단일 관심사. PR-H1만 무거움(문서 11개) — 정본 채택 게이트.

---

## 후행 재평가 노트 (2026-05-26 PR 실행 중 발견)

이 플랜의 Part 4/5 일부 PR은 코드 실측 후 폐기됐다. audit이 layering/SRP를 과대평가한 케이스.

### PR-R-CalendarLeak → **폐기**

audit-rust.md는 `commands/calendar.rs`의 4개 함수를 `calendar.rs`로 이전 권장. 실측:

- **`apply_calendar_urgency`**: `#[tauri::command]` + `#[specta::specta]` IPC 핸들러. 이동 불가.
- **`access_token_for`**: DB(`project_credential_ref`/`load_calendar_creds`) + keychain(`set_token`) + HTTP provider(`refresh_core`)를 함께 호출하는 cross-subsystem 글루. `calendar.rs`로 옮기면 거기에 `use crate::keychain; use crate::db::Db`가 들어가 도메인 모듈의 순수성이 오히려 훼손됨.
- **`fetch_events_windowed`**: `OnceLock<TtlCache>` 싱글톤 + DB + provider 호출 — 같은 문제.
- **`parse_quadrant_hint`**: 9줄 순수 helper. 단독 이전 가치 미미(PR 1개 값이 안 됨).

결론: 이 레포의 `commands/X.rs` ↔ `X.rs` 경계는 audit이 본 "leak"이 아니라 **의도된 글루 vs 도메인** 패턴이다. 글루(DB+keychain+provider orchestration)는 `commands/`가 자연스러운 위치. **권장 대안:** layering 가드는 `docs/areas/ipc-conventions.md`에 "글루는 commands/, 순수 도메인은 root /, 다른 서브시스템 import는 commands/만"으로 명시.

### PR-F-Capture (useCaptureActions) → **폐기**

audit-frontend.md는 `CaptureBoard.tsx`의 19 mutation hooks + 핸들러 3개를 `useCaptureActions` 훅으로 이전 권장. 실측:

- 핸들러들이 `signals`/`projects`/`selectedId`/`editingId`/`menu`/`enrichRunId`/`enrichAllRunId`/`projectPicker`/`calendarModal`/`expectPopRef`/`codexReady`/`pushSuccess`/`pushError` 등 12+ 로컬 state setter+ref+rederived 값에 깊이 결합.
- `useCaptureActions(deps: { ... 15+ fields ... })` 시그니처는 복잡성을 **줄이지 않고 옮기기만** 한다. LOC는 두 파일로 분산되지만 의존성 그래프는 동일 — 가독성 개선 0.
- 더 적절한 decomposition은 **하위 effect/sub-component 분리**(`CaptureKeyboardEffect`, `CaptureCalendarUrgencyEffect`, `CapturePopAnimation` 등)이지만 그건 audit이 권장한 방향과 다름.

결론: god-component 사이즈는 사실이지만 audit의 분해 권장이 안티패턴. **권장 대안:** 따로 디자인 세션을 잡아 sub-effect/sub-component 분해 방향으로 다시 설계.

### 폐기되지 않은 Part 4/5 PR들

PR-R-Models (audit-rust.md §models.rs special analysis — 14 도메인 그룹 facade) — 여전히 유효. M models.rs 충돌만 해소되면 진행 가능.

PR-R-Calendar (1432 LOC → 6 slice) — 여전히 유효. 단 OAuth 통합 smoke는 사용자 수동 검증 필요.

PR-F-Worktree (9 파일 분할) — audit이 가장 구체적이고 합리적인 분해 권장(독립된 sub-component 5개 + 1 hook). M WorktreeView.tsx 해소 후 진행 가능.

PR-F-Jobs (4 패널 추출) — 4개 패널이 실제로 독립적(SelfCheck/Enrich/BatchEnrich/Triage)이라 명확한 분해 경계 존재. CaptureBoard보다 분해 가치 분명함.

PR-F-CSS-Dead — 단순 삭제 작업, 여전히 유효.

### 학습 (audit과 실행 사이의 간격)

audit 결과는 **분해 후보 list**이지 자동 실행 대상이 아니다. 각 권장사항은 코드 실측에서 다음을 검사 후 채택:

1. 추출 대상이 진짜 독립적인가 (의존성 12+ deps는 false-positive)
2. 추출 후 정말 구조가 개선되는가 (LOC 분산은 개선 아님)
3. audit이 본 "leak"이 의도된 패턴인지 (commands/=글루 vs root=도메인은 이 레포의 의도)

이 재평가 패턴 자체를 `docs/areas/frontend-shell.md` + `docs/areas/ipc-conventions.md`에 "분해 전 의존성 그래프 검사" 가드로 추가 권장.

---

## 향후 follow-up (이 플랜 외)

1. **Doc budget 자동화** — `docs/areas/area-map.md`의 "forbidden when only this domain" 컬럼을 pre-commit 훅으로 강제 (잘못된 docs 로드 시 경고)
2. **Codex CLI 자동화 게이트** — 이번 turn에서 omc-teams cmux startup stall 재발견. `parallel-agent-safety.md`에 이미 명시. 향후 codex 워커 필요 시 native Task agent (sonnet/opus) 폴백 우선.
3. **AGENTS.md grep gate** — CI에서 AGENTS.md 길이 / "shadcn", "news" 등 도메인 키워드 출현 횟수 모니터링 (회귀 방지).
4. **`models.rs` facade 해체** — PR-R-Models 머지 후 ~2주 운영 후 직접 import로 전환.

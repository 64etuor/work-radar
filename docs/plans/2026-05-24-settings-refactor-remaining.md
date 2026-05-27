# Settings 리팩터링 — 남은 작업 플랜 (다음 세션 핸드오프)

> 상태: **APPROVED (pending user approval)** — ralplan consensus(Planner→Architect→Critic, deliberate). Architect 1패스 + Critic ITERATE→필수 변경 반영 완료.
> 작성: 2026-05-24 · 모드: 단독(autonomous) 다음 세션 실행용
> 선행 문서: `docs/plans/2026-05-24-ui-component-system-comparison.md`(shadcn 채택 근거), `AGENTS.md`(INVARIANTS), `DESIGN.md`(Cohere white editorial), `docs/reference/commands.md`(검증 번들)

---

## ⚠ 핸드오프 전제 (먼저 읽을 것)

- **이번 세션 작업(§0)은 전부 dev 워킹트리에 있으나 아직 미커밋이다.** `git status`에 수정/미추적(`??`)으로 보인다. 특히 `src/poc/`·`poc.html`은 git **미추적**.
- **다음 세션 첫 작업 = PR 0**: §0 Foundation+Projects 재설계를 **먼저 커밋**(dev). 그 전엔 트리를 **reset/stash/checkout 하지 말 것**(프로젝트 MEMORY 위험: "loop shares working tree" — 작업 손실).
- **분기 기준**: 현재 `dev` HEAD(작업 트리 dirty 상태). 새 브랜치는 dev에서, push는 dev만(main PR-only).
- **시각 검증 권위 경로 = `pnpm tauri dev`**(라이브 창). styleguide(`poc.html`)는 보조이며 **미커밋이라 없을 수 있다** — 없으면 tauri dev로 검증.

---

## 0. 이번 세션에서 이미 완료 (DONE, 단 미커밋 — 재작업 금지, PR 0로 커밋)

typecheck/lint/build green 확인됨.

- **결정**: shadcn/ui 채택, DaisyUI 기각(다크 패리티 미달 + 토큰체계 폐기). 근거 = 비교문서.
- **Foundation**:
  - `src/components/ui/`: `button.tsx`(variant: default/secondary/outline/ghost/destructive/**destructiveOutline**/**destructiveGhost**, size: default/sm/pill), `input.tsx`(ComponentProps<"input">, ref 가능), `label.tsx`, `badge.tsx`, `card.tsx`, `switch.tsx`(radix), `select.tsx`(radix), `cn.ts`.
  - `src/components/settings/kit.tsx`: `SectionLabel`, `Field`, `StatusDot`, `Segmented`.
  - `src/styles.css` 끝 shadcn 토큰 레이어: `:root`/`.dark` + `@theme inline` + 앱 전역 다크(`.dark`가 `--color-wr-*` 오버라이드) + `--destructive-soft`.
  - `store.ts` `theme`+`toggleTheme`(localStorage `wr-theme`), `App.tsx` 루트 `dark` 클래스, 설정 헤더 다크 토글.
- **Projects 패널 재설계**(훅/핸들러 보존): `SettingsView.tsx`, `AddProjectForm.tsx`(티켓 제거, `ticketKeyPattern: null`), `ProjectCard.tsx`(티켓·read-only 표시 제거), `TokenRow.tsx`(CLI 가져오기/웹 로그인 1차+고급 붙여넣기; 삭제=destructiveOutline), `GoogleAccountBlock.tsx`(OAuth+피커; read-only→읽기+쓰기; 연결 해제=destructiveOutline), `AddRepoForm.tsx`(티켓 제거, 폴더 선택 유지).
- **잔재(미추적)**: `src/poc/`·`poc.html`(styleguide, @/components/ui 사용) = git `??`. `daisyui` devDependency 미사용 잔존. 참고: `src/components/AgentStatusBar.tsx`가 "poc" 문자열 참조 → 삭제 전 확인 필요(PR D).

---

## 1. RALPLAN-DR Summary

### Principles (P1–P5)
- **P1 무손상 보존**: 기존 IPC 훅/핸들러/INVARIANT 동작 불변(마크업·스타일만). 백엔드(PR B)는 예외 + 명시 게이트.
- **P2 한 PR = 한 관심사**: FE 리스킨 / 티켓 제거 / 다크 미세조정 / 정리 분리.
- **P3 결정 레일 불가침**: PR Radar escalation·**알림** 변경은 사람 확정 후에만(INVARIANT #1/#4).
- **P4 검증은 증거로**: PR마다 명령 green + 관찰. self-approve 금지 → reviewer 패스.
- **P5 정본 정합**: DESIGN.md(Cohere) + src/components/ui + kit.tsx.

### Decision Drivers
1. 리스크 격리(티켓 제거 = #4 escalation+알림·migration). 2. 다음 세션 단독 실행성. 3. 시각 회귀 방지.

### Viable Options — PR 분할
- **Option A (채택)**: 5 PR(0 커밋 / A 리스킨 / B 티켓제거[게이트] / C 다크 / D 정리).
- **Option B (기각)**: 리스킨 1개 대형 PR — AGENTS.md "한 PR=한 관심사" 위반.
- **Option C (기각)**: 티켓 제거를 리스킨에 합침 — #4(escalation/알림) 회귀를 시각 변경에 묻을 위험.

### Viable Options — PR B escalation/알림 정책 (⚠ 사람 결정 · INVARIANT #4)
`escalation_reason`(`src-tauri/src/commands/pr_radar.rs:75-84`)은 `Open && CI Failing && ticket.is_some()`로 게이팅 — **티켓 링크가 #4 노이즈 필터**(주석 line 17, 테스트 `no_ticket_no_escalation` ~line 670). `enqueue_ci_failure_notification` **호출이 escalation 분기 안에 중첩**(line 222-228) → escalation = OS 알림.
- **컬럼만 DROP해도 중립 아님**: 패턴 소실 → `extract_ticket`→`None` → escalation 미발화 → PR Radar 전원 display-only 강제(=B2). 즉 #4 행동 변경 불가피.
- **B1(추천 형태)**: 티켓 전제를 **명시 노이즈 임계치로 치환**(예 `CI Failing && review_requested` 또는 `&& age>=N일`). dedup/auto-resolve/임계치/알림 커플링 보존, 알림 볼륨 테스트 재고정.
- **B2 ✅ 결정됨(2026-05-24)**: escalation 완전 비활성 → **PR Radar 표시 전용**. escalation에 종속된 **OS 알림 경로도 함께 제거**. (B1 임계치 치환 검토했으나 사용자가 "깔끔한 제거" 선호.) → PR B 게이트 해소.

---

## 2. Pre-mortem (3)
1. **다크 조정이 라이트를 깨뜨림** → 토큰 기본값=기존 라이트 hex 동일, `.dark`만 분기. **worktree-diff add/remove 의미색**은 theme-neutral로 잘못 토큰화 쉬움 → 그 뷰 픽셀 before/after 필수.
2. **migration 충돌** → 사내 선례 `migrations/0008_remove_mismatch.sql`이 bare `ALTER TABLE ... DROP COLUMN` 사용(db.rs:37 `sqlx::migrate!`). `0015_remove_ticket_key_pattern.sql` 동일 패턴. 런타임 순서 migrate→쿼리는 기존 `fresh_db()`(shared test_support) 테스트가 가드. **populated DB 실패 대비**: 0008이 동일 op를 이미 출하했으므로 위험 낮음, 단 PR에 "마이그레이션 실패 시 0015 revert + 재발행" 1줄 명시.
3. **escalation/알림 정책이 #4 위반** → B1/B2 사람 확정 + 새 기준 테스트 고정 + 알림 볼륨 테스트 + reviewer #4 전용 확인.

## 3. 확장 테스트 계획
- **Rust(PR B, B2)**: 기존 escalation/알림 테스트(`no_ticket_no_escalation`/`escalates_ci_failed_with_ticket`/`no_ticket_no_ci_notification`)는 **제거**(escalation 자체 소멸), **표시 전용**(fetch→목록 반환) + **auto_resolve**(기존 escalated PR 신호 정리) 테스트로 치환. `extract_ticket`/`escalation_reason`/`linked_ticket` 제거 반영. `cargo test`·`clippy` green.
- **FE**: vitest **스위트 green 유지**(고정 카운트 비의존).
- **Integration**: `cargo test`(bindings_export) 후 `git diff --exit-code src/bindings.ts`(드리프트 0).
- **관찰(헤드리스)**: FE PR마다 `pnpm tauri dev`(권위) 또는 styleguide 라이트/다크 스크린샷, 설정 5개 카테고리 전수, destructiveOutline 확인. PR C는 worktree-diff 뷰 라이트 픽셀 동일성.

---

## 4. 작업 단위 (PR)

### PR 0 — Foundation + Projects 재설계 커밋 (선행, 필수)
- §0의 미커밋 변경을 dev에 커밋(관심사: "설정 shadcn 도입 + 다크모드 기반 + Projects 재설계"). poc/daisyui 잔재는 이 커밋에 포함할지 결정(권장: poc는 styleguide로 별도 커밋 또는 보류, daisyui 제거는 PR D).
- **Verify**: `pnpm typecheck && pnpm lint && pnpm build` green 재확인 후 커밋. `docs/decisions.md` 한 줄.

### PR A — 나머지 설정 패널 shadcn 재설계 (FE, 저위험)
- **대상**: `AgentsPane.tsx`, `NavigationSettings.tsx`, `NotificationSettings.tsx`, `HermesBridgeBlock.tsx`.
- **접근**: `st-*`/인라인 style → `src/components/ui` + `kit.tsx`. **훅/핸들러/상태 보존**(codex status·model·프리셋, 키맵, 알림 토글=`Switch`, Hermes 연결). 파괴적 액션=`destructiveOutline`.
- **Acceptance(객관 게이트)**: `grep -rn "st-\|set-" src/components/settings/AgentsPane.tsx src/components/settings/NavigationSettings.tsx src/components/settings/NotificationSettings.tsx src/components/settings/HermesBridgeBlock.tsx` → **레이아웃 클래스 0건**(잔존 시 미완). 톤/다크 정상·전 기능 동작은 reviewer가 스크린샷 증거로 확인.
- **Verify**: `pnpm typecheck && pnpm lint && pnpm build` green; 5개 카테고리 라이트/다크 스크린샷; reviewer 패스.

### PR B — ticket_key_pattern 백엔드 제거 + escalation/알림 재정의 (백엔드, 고위험, ⚠게이트)
- **정책 = B2 (✅ 결정됨 2026-05-24)**: PR Radar **표시 전용** — escalation·티켓·알림(escalation 종속) 전부 제거. 게이트 해소.
- **`src-tauri/src/commands/pr_radar.rs`**: `extract_ticket`·`escalation_reason` 제거; `sync_pr_radar`에서 **escalate(`upsert_pr_signal`)·`enqueue_ci_failure_notification`(line 222-228) 호출 제거**(PR은 fetch해 목록만 반환); **`auto_resolve`는 유지**(기존에 escalate된 PR 신호를 표시전용 전환 시 정리); `RepoRef.ticket_pattern`·`PrRadarItem.linked_ticket` 제거; `fetch_github_repo_refs`(line 270) COALESCE 제거; **INVARIANT 헤더 주석(line 14-19, 74) "링크 티켓/escalation" 표현을 "표시 전용"으로 갱신**; 테스트를 **표시전용 + auto_resolve 정리**로 치환(escalation/알림 테스트 제거).
- **DB**: `src-tauri/migrations/0015_remove_ticket_key_pattern.sql` — `ALTER TABLE projects DROP COLUMN ticket_key_pattern;` + `ALTER TABLE repos DROP COLUMN ticket_key_pattern;`(0008 선례). 실패 시 0015 revert+재발행.
- **모델/커맨드**: `src-tauri/src/models.rs`(4곳), `commands/projects.rs`(SELECT/INSERT/seed), `notion.rs`/`worktree.rs`/`shared.rs`의 `ticket_key_pattern: None` 생성자 제거.
- **IPC/FE**: `cargo test`(bindings_export)로 `src/bindings.ts` 재생성; `AddProjectForm`/`AddRepoForm`의 `ticketKeyPattern: null` 제거; **`src/components/PrRadarView.tsx:207`의 `linkedTicket` 뱃지 렌더 제거**.
- **Acceptance**: `grep -rn "ticket_key_pattern\|ticketKeyPattern\|linked_ticket\|linkedTicket" src src-tauri` **0건**; PR Radar 새 정책 동작(또는 B2 display-only); `cargo test`+clippy green; bindings 드리프트 0.
- **Verify**: `cargo test`(pr_radar+notification)·`cargo clippy`·`pnpm typecheck/build`·`git diff --exit-code src/bindings.ts`; **reviewer 패스 필수**(#4 escalation+알림, #7 migration).

### PR C — 다크모드 미세조정 (CSS, 중위험)
- **대상**: `styles.css` 하드코딩 hex/rgb ~99개(특히 `.wt-l-add #e6f4ec` 등 diff 색).
- **접근**: 라이트값=기존 hex 동일 토큰화, `.dark`만 분기.
- **Acceptance**: 라이트 before/after **시각 동일(회귀 0)**, 다크 가독성.
- **Verify**: typecheck/build; **gstack `/browse` 스크린샷 diff** — worktree-diff 뷰 + board/jobs의 라이트 캡처 before/after **delta 0**(명명 셀렉터 기준), 다크 캡처 가독성 육안.

### PR D — 정리 (저위험, 신중)
- `pnpm remove daisyui`(미사용 확정 후).
- `src/poc/`·`poc.html`: **기본 KEEP**(styleguide 가치). 삭제하려면 `grep -rn "poc" src/ index.html vite.config.ts`로 라이브 import 전수 확인 — **`AgentStatusBar.tsx`의 "poc" 참조 먼저 조사**(오탐/실참조 판별). (`vite.config.ts`엔 rollupOptions.input 자체가 없음 → 빈 grep을 "안전"으로 오판 금지.) styleguide 존치/승격은 deletion과 분리 결정.
- 미사용 `.st-*`/`.set-*` dead CSS: PR A 후 `grep`로 미참조 확인된 것만 제거.
- **Verify**: build green, 앱 부팅, grep 증거.

---

## 5. 순서 / 의존성
**PR 0(커밋)** → **PR A** → **PR C** → **PR D**(daisyui 제거는 아무 때나). **PR B**는 독립 트랙(정책 게이트 후 언제든; FE PR과 파일 충돌 없음).

## 6. ADR
- **Decision**: 남은 작업 5 PR(0/A/B/C/D). PR B는 컬럼 DROP이 #4(escalation+알림)를 강제하므로 단일 게이트 PR 유지.
- **Drivers**: 리스크 격리, 단독 실행성, 시각 회귀 방지.
- **Alternatives**: 단일 대형 PR(기각: P2), 티켓을 리스킨과 합침(기각: #4 은폐), Architect의 chore/policy 2분할(부분 기각: 컬럼 DROP=정책 강제 → 허상).
- **Why chosen**: bisectable·리뷰가능·#4 보호 + 알림 블라스트 명시 + 미커밋 Foundation을 PR 0로 안정화.
- **Consequences**: PR 수↑, B는 사용자 결정 대기, Foundation 커밋 선행 필요.
- **Follow-ups**: B 정책(B1/B2)+알림 동의, poc 존치 여부, dead CSS 범위, populated DB migration 회수 절차.

---

## 7. 다음 세션 부트스트랩 지침
**읽기 순서**: `AGENTS.md` → `PLAN.md` §1 → `DESIGN.md` → 이 플랜(특히 ⚠전제) → `docs/decisions.md` → `docs/reference/commands.md`.
**환경**: cargo는 PATH에 없음 → cargo/`git commit`(husky pre-commit cargo fmt) 전 `export PATH="$HOME/.cargo/bin:$PATH"`. 검증: FE `pnpm typecheck && pnpm lint && pnpm build`, 백엔드 `cargo test && cargo clippy`(rtk cargo 부정확 → `rtk proxy cargo`/직접). **push는 dev만**. 시각: `pnpm tauri dev`(권위) + `/browse`; 브라우저 단독은 IPC `invoke` 없어 데이터 안 뜸(셸/폼/빈상태만).
**패턴**: 컴포넌트=`src/components/ui`+`kit.tsx`. 파괴적=`destructiveOutline`/중립=`outline`·`ghost`/CTA=`default`/토글=`Switch`. 리스킨은 마크업·className만(로직 변경 보이면 멈춤). 색은 토큰만.
**루프(PR마다)**: Acceptance 읽기 → 최소 구현 → Verify(증거) → critic/code-reviewer 패스(self-approve 금지) → `docs/decisions.md` 한 줄 → dev 커밋/푸시. **PR B는 정책+알림 게이트 + reviewer 필수.**
**금지**: 결정 레일 자동화(#1), feature+refactor 혼합, 무관 파일 정리, escalation/알림 기준 사람 미확정 변경, main 직접 push, 트리 reset/stash(미커밋 손실).

---

## 8. Consensus 로그
**Architect(1패스)**: grep에 linked_ticket/linkedTicket + PrRadarView.tsx:207 추가; escalation→알림 커플링 명시; migration 0008 선례 단순화; pr_radar 주석 갱신 범위; "chore 중립" 반론 → 컬럼 DROP이 정책 강제라 단일 게이트 유지(ADR).
**Critic(ITERATE→반영)**: (1) Foundation/poc 미커밋 → ⚠전제 + PR 0 + reset/stash 금지 + 분기 sha 명시; (2) PR D poc 게이트 오판 수정(`grep -rn "poc" src/ index.html vite.config.ts` + AgentStatusBar 조사 + 기본 KEEP); (3) PR A acceptance 객관 grep 게이트 + 톤/다크는 reviewer 증거; (4) PR C 스크린샷 diff 도구/delta 명시; (5) pr_radar 풀패스 1회 + "vitest 62"→"suite green" + populated DB 회수 1줄. → Critic "적용 시 APPROVE" 충족.

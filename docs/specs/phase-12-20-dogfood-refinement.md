# Phase 12–20 — Dogfooding 정교화 (통합 ralplan 정본 설계)

> PLAN.md Phase 0~11 완료 후, 사용자가 실제 앱을 dogfooding 하며 수집한 ~24개 수정/기능을
> brainstorming(AskUserQuestion)으로 정교화한 **통합 계획 정본**이다. 9개 Phase(12~20)로 분할되고,
> **에이전트 병렬 파견**을 전제로 의존 그래프·충돌 회피 전략을 함께 정의한다.
> 상위 규칙은 PLAN.md §1 INVARIANTS 7개 + AGENTS.md. PLAN.md Phase 12~20 / docs/decisions.md
> "Phase 12~20" 항목과 함께 읽는다.

---

## 0. 확정된 설계 선결 (사용자 결정, AskUserQuestion)

1. **목표 = 통합 ralplan.** 9개 Phase 전부를 잘 설계한다(순서 무관). 사용자가 phase별로 에이전트를
   병렬 파견한다 → 계획은 **병렬-안전(파일 충돌 최소)**이어야 한다.
2. **Auth 모델 = CLI 토큰 import.** 이미 로그인된 `gh`/`ntn`에서 토큰을 읽어(`gh auth token`) keychain에
   저장. 기존 octocrab/reqwest + keychain invariant 유지. 미로그인 시 앱 버튼이 `gh auth login --web` 실행.
   모든 토큰 어포던스를 이 패턴으로 통일. (ntn 토큰 비대화식 추출 가능 여부는 검증 필요 — 불가 시 paste fallback.)
3. **트레이 상주.** 루틴 알림을 위해 앱이 메뉴바/트레이에 상주 + 백그라운드 스케줄러. 창을 닫아도 알림.
   → 이 스파인이 루틴 알림(6)·CI 알림(17)·글로벌 에이전트 바(16)를 함께 받친다(별도 foundational Phase 13).
4. **스킬 관리 = 공유 레지스트리.** 인앱 에이전트 프롬프트 + 외부 Claude/Codex 스킬을 한 레지스트리에서 관리.
5. **inbox 제안 전체실행 = 단일 배치 잡.** 모든 미분류 카드를 한 codex 호출로 enrich(JSON 배열), 부분 실패
   격리. 결과는 suggested로만(자동 분류 0 — #1).
6. **보류 = snooze 재사용.** archived + snoozed 항목 열람 뷰 + 복원. 새 status/마이그레이션 없음.
7. **회고 = 전용 회고 뷰.** 기간 선택 → 완료 todo 타임라인 + impact/regret 태깅 + 랭킹 집계.
8. **루틴 스케줄 = 날짜 기준.** 월간=매월 같은 날짜(월말 클램프), 격주=앵커 2주 주기.
9. **worktree 변경중 = 둘 다.** live dirty 자동 갱신 + 활성 변경 활동(최근 파일 변경) 감지.
10. **dev rebase = 안전 rebase.** fetch → dirty면 거부 → 백업 ref → 충돌 시 abort+복구 → 결과 diff 검수.
11. **Hermes = 실제 메신저 브리지.** Telegram Bot API류로 외부 Hermes를 work-radar에서 송수신 제어.
12. **Calendar = 쓰기(생성) + 기존 읽기.** 카드→직접 모달→Google Calendar 이벤트 생성. 수정/삭제·연속 sync 없음.
13. **CI 봇 = GitHub Actions 훅 → 앱 알림.** 자동 triage 없음. 네이티브 알림 + Q1 escalate, 결정은 사람.
14. **prep refactor 먼저.** 병렬 파견 전 `commands.rs`/`query.ts`를 도메인 모듈로 분리(Phase 12).

---

## 1. Cross-cutting 아키텍처 (한 번 결정, 여러 Phase가 소비)

### A. 트레이 상주 스파인 + 알림 + 백그라운드 스케줄러 (Phase 13, foundational)
- 현재: 전역 핫키로 토글하는 단일 창. → **메뉴바/트레이 상주 앱**으로 전환. 창 닫기 = 트레이로 hide(quit 아님).
- `tauri-plugin-notification` + 권한 요청 플로우.
- **백그라운드 스케줄러** = managed state. bounded tick(예: 60s, busy-loop 금지 — #5). 등록형 due-check API
  (루틴 알림/CI 체크가 등록). 다음 발사 시각은 SQLite 영속(재부팅 복구).
- 소비처: Phase 16(루틴 알림), Phase 20(CI 알림/에이전트 바 라이브).

### B. Auth 스파인 — CLI 토큰 import (Phase 14)
- GitHub: `gh auth status` 감지 → `gh auth token` → keychain(`TokenKind::Github`). 미로그인 → 앱 버튼
  `gh auth login --web`(tokio::process) 후 재import. gh 미설치 → 설치 안내 + paste fallback.
- Notion: `ntn` 토큰 비대화식 추출 가능하면 import → keychain(`TokenKind::Notion`). 불가 시 paste fallback +
  "ntn 로그인" 런처. (구현 전 ntn CLI 토큰 노출 능력 검증 — 본 spec의 유일한 미확정 의존.)
- Settings UI: raw paste row → "gh/ntn에서 가져오기" 1차 어포던스 + 상태, paste는 advanced fallback.
- 기존 invariant 유지: 토큰 keychain만, 렌더러/DB 평문 0, project별 분리.

### C. 공유 드래그 정렬 유틸 (Phase 16·17 공용)
- 루틴(2)·Today(3) 둘 다 Notion식 드래그 정렬. **dnd 프리미티브 1개**(예: dnd-kit 또는 경량 native HTML5 DnD)
  + `rank` 컬럼 패턴. → 작은 공용 유틸 PR로 먼저 추출하거나, 둘 중 먼저 착수하는 Phase가 만들고 다른 쪽이 재사용.

### D. ⚠️ 병렬 충돌 회피 전략 (가장 중요)
- **핫 공유 파일:** `commands.rs`(3500+줄, #1 hot path), `models.rs`, `lib.rs`, `query.ts`, `App.tsx`,
  `store.ts`, `styles.css` — 거의 모든 Phase가 건드림 → 병렬 8 에이전트 = 머지 지옥.
- **전략(확정): Phase 12에서 prep refactor 먼저.**
  - 12a MISMATCH 전체 제거(표면 축소) → 12b `commands.rs`/`query.ts`를 **도메인 모듈**(routines/today/
    capture/calendar/agents/git/settings/notion/github)로 분리. 커맨드 등록·bindings 동일 유지(행위 무변경 리팩터,
    AGENTS.md 준수 — feature와 안 섞음). 이후 phase들이 서로 다른 모듈 파일을 건드려 충돌 최소화.
  - `lib.rs`(커맨드 등록)·`store.ts`(View enum)·`App.tsx`(렌더 스위치)·`styles.css`는 여전히 공유 →
    **append-friendly**하게(끝에 추가) 작성하고, 병렬 머지는 dev에 **하나씩 rebase**.

---

## 2. Phase 12 — Prep/Cleanup + Git 운영
**Goal:** 병렬 파견 기반 마련(표면 축소 + 모듈 분리) + worktree/브랜치 운영 기능.
**Depends on:** 없음 (제일 먼저 — 12a→12b는 게이트).

### 2a. MISMATCH 전체 제거 (feature removal, 1 PR)
- 프런트 삭제: `MismatchView.tsx`; `App.tsx` case "mismatch"; `store.ts` View "mismatch"; CommandPalette 항목;
  `query.ts` `MISMATCH_POLL_MS`/`fetchMismatch`/`useTriggerMismatchDraft`/`useMismatchDraftProposal`/
  `useAcceptMismatchDraft`/`useSetNotionDoneStatuses`; `settings/` DoneStatusEditor.
- Rust 삭제: `commands.rs` `refresh_mismatch`/`trigger_mismatch_draft`/`mismatch_draft_proposal`/
  `accept_mismatch_draft`/`execute_accept_mismatch_draft` + 헬퍼(`parse_done_statuses`/`mismatch_dedup_key`/
  `upsert_mismatch_signal`/`auto_resolve_mismatch`/`sync_mismatch`)/`set_notion_done_statuses` +
  `MISMATCH_DRAFT_PROMPT`; `models.rs` `SignalType::Mismatch`/`MismatchItem`/`TriggerMismatchDraftInput`/
  `NotionUpdateProposal`; `lib.rs` 해당 커맨드 등록 해제.
- DB: migration(다음 번호) — 기존 mismatch 신호 DELETE + `projects.notion_done_statuses` 컬럼 제거 +
  `signals.snapshot`가 mismatch 전용이면 제거(SQLite 테이블 재작성). `projects.notion_backlog_db_id`는
  Phase 3 Notion 승격에서 쓰므로 **유지**.

### 2b. commands.rs / query.ts 도메인 모듈 분리 (refactor, 1 PR)
- 행위 무변경. 커맨드 등록 순서·시그니처·bindings 동일. 도메인별 파일로 이동(목표 각 ~500줄 이하).
- cargo test의 bindings export가 동일 산출물인지로 회귀 검증.

### 2c. worktree 변경중 표시 + 안전 dev rebase (1 PR)
- 변경중(둘 다): WorktreeView에서 dirty 상태를 **자동 갱신**(폴링 또는 파일워치) + **활성 변경 활동**(최근
  파일 mtime 윈도) 표시. "지금 작업 중"을 한눈에.
- 안전 rebase: 커맨드 `rebase_worktree_onto(path, base="origin/dev")` — fetch → dirty면 거부 →
  백업 ref(`refs/wr-backup/<ts>`) → `git rebase` → 충돌 시 `--abort`+백업 복구+상태 노출 → 성공 시 결과 diff
  를 기존 Diff Viewer로 검수. 사용자 worktree 대상이지만 명시 버튼 = 사람 액션(가드 포함).

### 2d. 브랜치/워크트리 정리 (1 PR)
- merged/stale 브랜치 + prunable worktree 목록 → 다중 선택 → 확인 후 삭제. **current/dirty/미머지 보호**
  (강제 삭제 옵션은 별도 명시 토글). `git worktree prune` 연계.

**Done-criteria:**
- [ ] `grep -ri mismatch src src-tauri` → 0 (git 이력/decisions 제외). mismatch 신호+컬럼 마이그레이션 제거
- [ ] `commands.rs`/`query.ts` 도메인 모듈 분리, 커맨드 등록·bindings 동일, cargo test/clippy/typecheck/build green
- [ ] worktree: live dirty 자동 갱신 + 활성 변경 활동 표시
- [ ] 안전 dev rebase: fetch→dirty 거부→백업 ref→충돌 abort+복구→결과 diff 검수
- [ ] 브랜치/워크트리 정리: merged/stale 목록·다중선택·확인 삭제, current/dirty 보호

---

## 3. Phase 13 — 트레이 상주 스파인 + 알림 + 스케줄러 (foundational)
**Goal:** 메뉴바 상주 + 알림 + 백그라운드 스케줄러 스파인(16·20이 등록·소비).
**Depends on:** 없음 (early). **소비처:** 16, 20.
**Deliverables:** §1.A. tray icon/menu(show/hide/quit), 닫기=트레이 hide, `tauri-plugin-notification`+권한,
`Scheduler` managed state(bounded tick·등록형 due-check·다음 발사 SQLite 영속).
**INVARIANT:** #5(스케줄러 bounded, busy-loop 금지).
**Done-criteria:**
- [ ] 트레이/메뉴바 상주, 창 닫아도 백그라운드 유지, 트레이에서 show/hide/quit
- [ ] 알림 권한 요청 + 테스트 알림 발송 (사용자 관찰)
- [ ] 스케줄러 bounded tick 동작(무한 busy-loop 아님), 등록 due-check 호출, 재부팅 후 다음 발사 복구

---

## 4. Phase 14 — 온보딩 & Auth
**Goal:** 토큰 어포던스 통일(CLI import) + 키체인 프롬프트 + 폴더 picker.
**Depends on:** 없음.
**Deliverables:**
- (8) **키체인 프롬프트 fix = 안정 코드서명.** 매 리빌드마다 서명이 바뀌어 keychain ACL이 무효화 →
  매번 암호 프롬프트. Tauri macOS 번들을 **안정 서명 아이덴티티**(Developer ID 또는 keychain에 등록한
  안정 self-signed cert)로 서명하도록 설정 + 문서화. (Apple Developer 계정 없으면 self-signed cert 생성 절차.)
- (9) **폴더 picker:** `tauri-plugin-dialog` `open({directory:true})`로 repo local_path 등 경로 입력 통일
  (붙여넣기 제거).
- (18/19) **CLI 토큰 import:** §1.B. Settings UI를 "gh/ntn에서 가져오기" 1차 + paste fallback로 재구성.
**INVARIANT:** 토큰 keychain만·렌더러/DB 평문 0·project별 분리.
**Done-criteria:**
- [ ] 안정 서명 → keychain 접근 시 매번 암호 프롬프트 안 뜸(리빌드 후에도) — 사용자 관찰
- [ ] repo local_path가 폴더 picker(붙여넣기 아님), 경로 입력 어포던스 통일
- [ ] GitHub: gh 로그인 감지 → `gh auth token` import → keychain; 미로그인 시 앱 버튼 `gh auth login --web`
- [ ] Notion: ntn 토큰 import(가능 시) → keychain; 불가 시 paste fallback + ntn 로그인 안내
- [ ] 토큰 keychain만, 평문 노출 0 (기존 invariant)

---

## 5. Phase 15 — Capture / Inbox UX
**Goal:** 미분류 전체 일괄 enrich + 브레인덤프 편집/삭제.
**Depends on:** 없음.
**Deliverables:**
- (4) **단일 배치 enrich 잡:** `trigger_enrich_all(project_id?, bounds)` — 모든 미분류 카드를 `cards.json`
  배열로 모아 한 codex 호출 → `[{id, suggested_quadrant, suggested_area}]` 반환, 카드별 파싱·부분 실패 격리.
  Acceptance 게이트 후 accept가 **suggested_*만** 반영(quadrant 자동 확정 0 — #1). UI: 미분류 영역 상단
  "전체 제안 실행" 버튼 1개. (카드별 ⋯ 'AI 제안'은 유지 가능.)
- (5) **브레인덤프 편집/삭제:** `update_signal_title(id, title)`(dedup 키 갱신) + `delete_signal(id)`(하드 삭제,
  archive와 구분). 카드 인라인 편집 + 삭제(확인).
**INVARIANT:** #1(suggested-only), #2(accept 전 외부 무변경), #5(배치 잡 bounds).
**Done-criteria:**
- [ ] "전체 제안 실행" 버튼 1개로 모든 미분류 카드 enrich(단일 codex 배치 잡, bounded), 부분 실패 격리
- [ ] 배치 결과가 각 카드에 suggested_quadrant/area로 표시(자동 분류 0)
- [ ] 브레인덤프 카드 제목 편집 + 하드 삭제(archive와 구분), 편집 시 dedup 키 갱신
- [ ] accept 전 외부 무변경, 잡 bounds 적용

---

## 6. Phase 16 — Routines 강화
**Goal:** 격주/월간 스케줄 + 드래그 정렬 + 시간/알림 + 트래킹 차트.
**Depends on:** 13(스케줄러/알림), C(드래그).
**Deliverables:**
- (1) **격주/월간(날짜):** `RoutineFreq` += `Biweekly`/`Monthly` + `anchor_date` 컬럼(migration). 월간=매월
  같은 day-of-month(월말 클램프, 31→그달 말일), 격주=`(date-anchor)%14==0`(선택 요일 + 앵커 주 parity).
  `list_today_routines`가 신규 freq의 오늘 해당 여부 계산.
- (2) **드래그 정렬:** `routines.rank` + `reorder_routines(ordered_ids)`, 공용 dnd(C).
- (6) **시간 + 알림:** `routines.time_of_day?` + `reminder_offset_min?`(예: 30분 전). Phase 13 스케줄러가
  `time - offset`에 알림. 알림 클릭 → 앱/루틴 포커스. 기본 오프셋 Settings.
- (12) **트래킹 차트:** 루틴 트래킹 뷰 — 이행률(%)·연속(streak)·히스토리(히트맵). `routine_checks` 집계.
**INVARIANT:** #5(스케줄러 bounded).
**Done-criteria:**
- [ ] 격주(앵커 2주)·월간(같은 날짜, 월말 클램프) 추가, 오늘 해당 루틴만 표시
- [ ] 루틴 드래그 정렬(rank 영속), Today와 동일 패턴
- [ ] 루틴별 시간 + 알림 오프셋, 트레이 상주 중 스케줄러가 알림 발송 (사용자 관찰)
- [ ] 루틴 트래킹 뷰: 이행률/streak/히스토리 차트

---

## 7. Phase 17 — Today / Todo & 회고
**Goal:** Today 드래그 정렬 + 전용 회고 뷰 + 보관함(archived+snoozed).
**Depends on:** C(드래그).
**Deliverables:**
- (3) **Today 드래그 정렬:** TodayRail ±1 버튼 → 드래그(공용 C). `reorder_today` 재사용.
- (13) **전용 회고 뷰**(`view:"retro"`): 기간 피커 → 완료 todo(`today_done_at` 범위) 타임라인 + 각 항목
  **impact(고임팩트 ⭐)/regret(하지말걸 ⚠️)** 태깅. 컬럼 `signals.impact_high`/`signals.regret`(migration).
  커맨드 `list_completed(range)`/`set_signal_impact(id,bool)`/`set_signal_regret(id,bool)`. 집계: 고임팩트/낭비
  랭킹. 로컬 전용·사람 태깅(#1/#2 N/A).
- (14) **보관함 뷰:** archived + snoozed 열람 + 복원(`restore_signal` — archived→unclassified, snoozed→원 사분면).
  커맨드 `list_archived_snoozed`. 새 status 없음(snooze 재사용).
**INVARIANT:** 로컬 액션(#2), 자동 분류 0(#1).
**Done-criteria:**
- [ ] Today 레일 드래그 정렬(±1 버튼 제거, Notion식)
- [ ] 회고 뷰: 기간 선택 → 완료 todo 타임라인 + impact/regret 태깅 + 랭킹 집계
- [ ] 보관함 뷰: archived + snoozed 열람 + 복원
- [ ] 모든 액션 로컬, 자동 분류 0

---

## 8. Phase 18 — Navigation & UI/UX 폴리시
**Goal:** 단축키/창키/전환효과/중복 제거 + 전체 UI/UX 밸런스 audit.
**Depends on:** **늦게**(광범위 UI 변경 — 다른 phase와 충돌 → fleet 마지막).
**Deliverables:**
- (7) **메뉴별 단축키:** Settings 저장 keymap(view→shortcut), **글로벌 창 핫키 변경 가능**(현 Alt+Space →
  편집·영속·`tauri-plugin-global-shortcut` 재등록). **화면 전환 효과**. **중복 기능 제거** — audit 후보:
  Today/Timeline 중복, Today 레일 이중(보드+TodayView), 뷰 간 Q1/캘린더 중복. 네비 정리.
- (24) **UI/UX 밸런스 audit:** DESIGN.md 기준 audit → punch-list → 수정(간격/위계/일관성). 착수 시
  `/design-review`(gstack) 권장.
**INVARIANT:** DESIGN.md 정본(Cohere white editorial), 웹 전용 컴포넌트 금지.
**Done-criteria:**
- [ ] 메뉴별 단축키 등록/편집(저장), 글로벌 창 핫키 변경 가능(재등록)
- [ ] 화면 전환 효과, 중복 뷰/기능 정리(audit punch-list 반영)
- [ ] DESIGN.md 기준 UI/UX 밸런스 audit + 수정

---

## 9. Phase 19 — Calendar 쓰기 (이벤트 생성)
**Goal:** 카드→직접 모달→Google Calendar 이벤트 생성(write). 기존 읽기 유지.
**Depends on:** Phase 10 OAuth(존재).
**Deliverables:**
- scope `calendar.readonly` → `calendar.events` **업그레이드(재동의)**, 토큰 keychain 유지.
- `CalendarProvider`에 `create_event` 확장 + Http 구현(reqwest, bounded). 커맨드
  `create_calendar_event(project_id, calendar_id, event)`.
- 카드 액션 "캘린더 등록" → **직접 모달**(제목=카드 prefill, 시작/종료 시간, 캘린더 선택, 설명) → 제출 →
  Google write. **acceptance 대기 Promotion draft 경로 제거**(사용자 폼 = 사람 결정 — 게이트는 자동화용).
**INVARIANT:** #2(사용자 폼=사람 결정이므로 직접 write 정합), 외부 호출 Rust·bounded·graceful degrade.
**Done-criteria:**
- [ ] OAuth scope events 업그레이드(재동의), 토큰 keychain 유지
- [ ] 카드 "캘린더 등록" → 직접 모달 → Google Calendar 이벤트 생성(write)
- [ ] acceptance 대기 제거(사용자 폼=사람 결정), write는 Rust·bounded, 생성 실패 graceful
- [ ] 읽기 레일(Phase 10) 영향 없음

---

## 10. Phase 20 — Agents & AI surface
**Goal:** Hermes 메신저 브리지 + 글로벌 에이전트 바 + CI 봇 알림 + 스킬 공유 레지스트리.
**Depends on:** 13(16-바 라이브/17-CI 알림). **소비:** 기존 Jobs/AgentRun.
**Deliverables:**
- (15) **Hermes 메신저 브리지:** Telegram Bot API류. 봇 토큰 + chat_id keychain(`TokenKind::HermesBridge`).
  송신 `send_hermes_message(text)`(sendMessage), 수신 `getUpdates` **bounded long-poll**(웹훅 미수신 데스크톱).
  제어 surface(채팅형, Jobs 또는 신규 뷰) — Hermes에 명령 전송·응답 표시. (메신저 추상화로 타 메신저 확장 여지.)
- (16) **글로벌 에이전트 바:** 모든 뷰 상단 상주 스트립. 활성/최근 agent run을 **stacked 세그먼트**(상태별 색:
  running/awaiting/failed). 실행 중 세그먼트는 **경과/timeout 비율**로 진행 표시(codex 실 % 없음 → 경과 프록시).
  클릭 → Jobs. **모든 AI 작업 집계**(codex 잡·배치 enrich·Hermes·CI). `useAgentRuns` 폴링, 트레이 상주로 라이브.
- (17) **CI 봇 알림:** GitHub Actions `if: failure()` 훅 → **앱 알림**. 1차=앱이 기존 GitHub 폴링(PR Radar)으로
  신규 CI 실패 감지 → 네이티브 알림 + Q1 escalate. 보강=재사용 Actions 스니펫(`if: failure()`)이 실패 컨텍스트
  (잡명/로그 URL)를 경량 푸시 채널(권장 ntfy.sh topic, 무계정)로 전송 → 앱 구독(SSE) → 알림. **자동 triage 없음**
  (사람 결정), notify 캡. (푸시 채널 ntfy 선택은 사용자 리뷰에서 확정.)
- (21) **스킬 공유 레지스트리:** 인앱 에이전트 프롬프트(현 하드코딩 self-check/enrich/triage)를 DB/파일 백킹
  레지스트리로 이전 + UI(보기/편집/추가, prompt+입력 바인딩+rail) + **외부 Claude/Codex 스킬**(~/.claude/skills 등)
  열람/토글/편집을 같은 레지스트리에서. 잡에 스킬 바인딩.
**INVARIANT:** #1/#2(스킬 편집해도 자동화는 제안 레일+Acceptance 게이트 유지), #5(Hermes poll·CI notify bounded·캡).
**Done-criteria:**
- [ ] Hermes: 봇 토큰/chat keychain, 앱에서 메시지 송신 + 응답 수신(bounded poll), 제어 surface
- [ ] 글로벌 에이전트 바: 모든 뷰 상단 상주, 활성/최근 잡 stacked, 실행 중 경과 비례 진행, 클릭→Jobs
- [ ] CI 봇: Actions 실패 훅 → 네이티브 알림 + Q1 escalate(자동 triage 없음), notify 캡
- [ ] 스킬 레지스트리: 인앱 프롬프트 + 외부 Claude/Codex 스킬 한 곳에서 보기/편집/추가, 잡 바인딩
- [ ] 자동화는 제안 레일 + Acceptance 게이트(#1/#2), Hermes/CI bounds(#5)

---

## 11. 의존 그래프 & 병렬 파견 전략 (waves)

```
Wave 0 (순차·게이트):   12a(MISMATCH 제거) → 12b(모듈 분리)
                          └ dev 머지 후에야 병렬 안전
Wave 1 (병렬):           13(트레이 스파인)  14(Auth)  15(Capture)  17(Today/회고)
                          19(Calendar write)  12c(worktree/rebase)  12d(브랜치 정리)
Wave 2 (병렬, 13 머지 후): 16(Routines: 알림 의존)   20(Agents: 바/CI 알림 의존)
Wave 3 (마지막·단독):     18(Nav & UI 폴리시 — 광범위 UI 충돌)
```

- **공용 드래그(C):** 16·17 둘 다 필요 → 둘 중 먼저 착수한 쪽이 dnd 유틸 추출, 다른 쪽 재사용(또는 1-파일
  공용 PR 선행). 16은 Wave 2라 17(Wave 1)이 유틸을 먼저 만드는 게 자연스러움.
- **공유 파일(`lib.rs`/`store.ts`/`App.tsx`/`styles.css`):** 모듈 분리 후에도 공유 → append-friendly 작성 +
  dev 머지는 phase별 하나씩 rebase(work-radar push는 dev만, main은 PR).
- 각 Phase = 한 관심사 PR(들). Phase 내 PR도 done-criteria green + INVARIANTS reviewer(self-approve 금지) 후 머지.

## 12. INVARIANT 적합성 요약 (phase × invariant)

| Phase | 핵심 invariant 처리 |
|---|---|
| 12 | rebase=사용자 worktree 대상이나 명시 버튼+가드(#6는 *에이전트* 격리 — 위반 아님). 정리=보호 가드. |
| 13 | 스케줄러 bounded tick(#5), busy-loop 금지. |
| 14 | 토큰 keychain·렌더러/DB 평문 0·project별 분리(불변). |
| 15 | 배치 enrich=suggested-only(#1), accept 전 외부 무변경(#2), 잡 bounds(#5). |
| 16 | 알림 스케줄러 bounded(#5). 루틴=로컬. |
| 17 | 회고/보관함=로컬 read+사람 태깅(#1/#2 N/A). |
| 18 | DESIGN.md 정본, 결정 레일 UI 불변. |
| 19 | 사용자 폼=사람 결정 → 직접 write 정합(#2), Rust·bounded·graceful(#5 정신). |
| 20 | 스킬 편집해도 자동화는 제안 레일+Acceptance(#1/#2). Hermes poll·CI notify bounded·캡(#5). CI 봇 자동 triage 없음(#1 결정 레일 보호). |

## 13. 검증 계획 (공통)

- Rust: 순수 로직(스케줄 계산·rebase 가드·배치 파싱·회고 집계·캘린더 create 페이로드)·`CalendarProvider`/
  `AgentRunner` fake로 `cargo test`. clippy -D warnings, fmt --check. (cargo는 `export PATH="$HOME/.cargo/bin:$PATH"` 후.)
- 프런트: pnpm typecheck/build. bindings 재생성(cargo test export). specta i64/u64 금지(i32/u32, f64는 `?? 0` 가드).
- **사용자 관찰**(헤드리스 불가): 실 트레이/알림, 코드서명 keychain 영속, gh/ntn 실 import, 실 Google write,
  실 Telegram 송수신, 실 codex 배치, 실 git rebase/cleanup, 실 GUI 렌더/전환.
- 각 PR 종료 시 INVARIANTS reviewer(critic) 패스(self-approve 금지) → `docs/decisions.md` 한 줄.

## 14. 미확정 / 리뷰에서 확인할 것

1. **ntn 토큰 비대화식 추출 가능 여부**(Phase 14) — 불가 시 paste fallback로 degrade.
2. **CI 봇 푸시 채널**(Phase 20) — 1차는 기존 GitHub 폴링 감지로 충분, Actions→앱 보강 채널은 ntfy.sh 권장(무계정).
3. **드래그 라이브러리**(C) — dnd-kit vs 경량 native. 착수 phase에서 최소 의존으로 선택.
4. **글로벌 에이전트 바 시각 디자인**(Phase 20-16) — 본 spec은 동작 정의까지. 픽셀은 DESIGN.md + Phase 18 audit에서.

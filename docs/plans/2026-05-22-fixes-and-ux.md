# Work Radar — 버그/정합성 + UX 리팩터 플랜

> 상태: **pending approval** (ralplan consensus — Planner→Architect→Critic APPROVE, iter 2)
> 작성: 2026-05-22 · 실행: 승인 후 PR 단위 자율 진행 (Phase A 완료 → Phase B)

## RALPLAN-DR 요약

**Principles**
1. 가장 작고 국소적인 변경. 요청 범위 밖 리팩터 금지.
2. INVARIANTS 7개 우선 — 특히 #1(결정 레일 사람만), #2(Acceptance 게이트), #5(잡 바운드), #7(SSOT/keychain/specta).
3. 정합성(버그) 먼저, UX 개편 나중. A7a(에러 계약)는 B의 선행 계약.
4. 모든 done-criteria는 실행/관찰 가능한 증거.

**Decision Drivers** — (1) 사용자가 실제로 막힌 버그(캘린더·노션·백로그·헤르메스) 우선, (2) 레일 경계 보존, (3) executor가 질문 없이 구현 가능한 명세 수준.

**Viable Options 검토**
- *전부 한 플랜 PR별*: 빠른 일괄 처리 but 버그/리팩터 혼재(AGENTS.md 금지) → 기각.
- *블로킹 버그만*: 안전하지만 UX 부채 미해결 → 부분만.
- *2단계 게이트(채택)*: A(버그/정합성) → B(UX). feature/refactor 분리 + 위험 격리.

---

## INVARIANT 준수 메모 (Architect/Critic 합의)
- **A2** 단일 프로젝트 auto-assign 은 "auto-assigned to X — change in settings" **가시 라벨**을 동반 → #1의 정신 보존(자동 분류 아님, 사용자 보이는 편의).
- **B3** enrich는 계속 `jm.spawn(gated=true)` 경유, 모달은 `awaiting_approval` 폴링 + `proposal` 컬럼 렌더 → #2/#5 보존. **동기 인라인 호출 금지.**
- **B4** `BINDING_PR_SELFCHECK` 키 보존(표시명만 변경) → skills 테이블 고아행 방지. `comment_count`는 기존 fetch 응답에서 읽음(추가 API 호출 없음) → #5 보존.
- 모든 신규 IPC는 tauri-specta 바인딩 등록(#7). 토큰은 keychain 유지(#7).

---

## PHASE A — 버그/정합성

### A1 · 캘린더 스코프 수정
- `src-tauri/src/calendar.rs:41` `CALENDAR_SCOPE` `calendar.events` → `calendar`(full, 사용자 인용 스코프).
- `CalendarError`에 **`ReconnectRequired(String)` 변형 추가**. `list_google_calendars`가 스코프 관련 403을 받으면 이 변형 반환 → 프런트가 재연결 프롬프트로 매핑.
- **AC**: 구 스코프 토큰으로 403 강제 시 `ReconnectRequired` 반환됨 / 재연결 후 `list_google_calendars`가 403 없이 캘린더 반환 / 이벤트 생성 정상.

### A2 · 백로그 승격 프로젝트 라우팅
- `promote_to_notion`(`commands/notion.rs:230`)에 **선택적 `project_id` 파라미터** 추가. 신호 `project_id` NULL이면 백엔드가 해소: 해당 kind 프로젝트가 정확히 1개면 auto-assign(기존 `reconcile_signal_projects` 쿼리 로직 재사용), 복수면 에러. IPC 응답에 해소된 `project_id` 포함.
- 프런트: auto-assign 시 "auto-assigned to X — change in settings" 라벨, 복수면 프로젝트 선택 모달을 승격 전에 표시.
- **AC(백엔드)**: NULL-프로젝트 신호 + 매칭 프로젝트 1개로 promote 호출 시 응답에 resolved project_id 포함. **AC(프런트)**: 단일 → 라벨 노출 후 승격 성공 / 복수 → 선택 모달 후 라우팅.

### A3 · 노션 DB 해소 ("couldn't find database")
- (a) 설정 저장 시 입력 정규화(URL/쿼리/대시 제거) + `GET /databases/{id}`로 **DB 여부 검증**, 페이지 id/데이터소스 불일치는 actionable 메시지로 거부.
- (b) `NotionError`에 **타입드 서브변형 `NotFound` / `Forbidden`**(+ 기존 `Terminal`) 추가 → 404(없음/미공유/잘못된 타입) vs 403(권한)을 사용자 카피로 구분.
- (c) "연결 테스트" 버튼이 정확한 결과 노출.
- **AC**: 페이지 URL 붙여넣기는 저장 시 안내와 함께 거부 / 유효 DB id 통과 / 올바른 바인딩에서 promote 404 사라짐.

### A4 · 헤르메스 chat-id 헬퍼 (403 fix)
- "chat id 감지" 버튼: `getUpdates` 호출 → `chat.id` 추출, **봇 chat id 거부**, 403 "can't send to bot" 친절 안내, 저장 시 검증.
- **AC**: 봇에게 메시지 후 감지 클릭 → 유효한 비-봇 chat id 채워짐 → 전송 성공.

### A5 · 루틴 편집/삭제
- `update_routine` + `delete_routine` Rust 커맨드 + tauri-specta 바인딩 + UI(편집 폼, 확인 후 삭제).
- 삭제 시: 루틴 + `routine_checks` 행 + **미발화 `scheduled_notifications`(`source='routine' AND source_id LIKE 'routine:{id}:%'`)** 제거. 발화/이력 행은 보존.
- **AC**: 편집 영속 / 삭제 시 고아 체크행·미발화 알림 없음.

### A6 · 워크트리 diff 정합성
- 기본 선택이 **해당 워크트리의 working tree**를 diff (working+staged 즉시 표시, branch-branch 수동 선택 불필요). `vs_base` 기본 base = **dev**.
- working/staged 빈 diff 버그 수정.
- mtime 휴리스틱 기반 거짓 "working" 상태 제거 → **무활동 90s면 idle**, 세션 지속시간 표시.
- **AC**: 미커밋 변경 있는 워크트리 열면 기본으로 working/staged에 표시 / 멈춘 워크트리는 "working" 아닌 idle.

### A7a · 에러 계약 (백엔드, **Phase B 선행**)
- 타입드 에러 + **8자 base32 trace id**, 로테이팅 파일 로그(최대 5파일 × 1MB), IPC로 노출. 로그 경로 설정에 노출.
- **AC**: 강제 실패 시 trace id가 토스트 페이로드와 로그 파일 양쪽에 존재.

### A7b · 에러 UX
- 토스트에 복사 버튼 + trace id, 에러는 dismiss까지 유지, 성공 토스트는 짧게, 비동기 작업 로딩 스피너.
- **AC**: 에러 토스트가 dismiss까지 유지되고 "{message} ({traceId})" 복사 / 느린 작업에 스피너.

---

## PHASE B — UX 리팩터 (A7a 계약 확정 후)

### B1 · 에이전트 바 재설계
- 실행 중 엔진 구분(Codex 인앱 프롬프트 vs Hermes) — 엔진별 아이콘 + 작업 라벨. 무잡이면 "idle". 실행 중엔 경과시간에 따라 늘어나는 박스 + 진행 채움.
- **cmux best-effort 읽기전용 인디케이터**(별도 세그먼트), cmux CLI 없으면 graceful 숨김. cmux 데이터는 결정에 절대 미투입.
- **AC**: 실행 중 Codex 잡 → 아이콘+라벨+채움 / 무잡 → "idle" / cmux 부재 → 에러 없이 세그먼트 숨김.

### B2 · 설정창 macOS 사이드바 분할
- 좌측 카테고리: Projects / Agents / Shortcuts / Integrations(Notion·GitHub·Calendar·Hermes) / Notifications.
- **Agents**: Codex 모델 설정 — `app_config` 키 `agent.codex_model`에 SQLite 영속, `codex exec --model`로 전달. 키 부재 시 현재 Codex 기본 모델.
- **Shortcuts**: **키 캡처 위젯** — 실제 조합을 눌러 기록(⌘K modifier + vim chord 둘 다), 가독 라벨 표시.
- **AC**: 카테고리 전환 시 우측 패널 교체 / 선택 모델이 재시작 후 유지되고 다음 Codex 잡에 사용 / 단축키 캡처가 실제 입력 조합 기록.

### B3 · 브레인덤프 enrich 인플레이스 모달
- 항목 인라인 편집 가능. per-card 개별 AI 제안 제거, 사분면 제안을 enrich에 통합.
- enrich는 계속 `jm.spawn(gated=true)`, 모달이 **전용 단일 run_id 상태 커맨드를 1s 폴링**하며 `proposal` 컬럼 렌더, 사용자가 Accept(게이트) 또는 편집 후 accept. (Jobs view 이동 없음.)
- **AC**: enrich 트리거 시 그 자리 모달 / 잡이 여전히 agent runs에 바운드와 함께 등장 / accept 적용·reject 폐기·편집후accept 동작.

### B4 · PR 레이더 개편
- PR **코멘트 수 트래킹**: `comment_count = comments + review_comments`를 기존 `fetch_prs` 리스트 응답에서 읽음(추가 per-PR 호출 없음). `RawPr`/`PrRadarItem`에 표시 전용 필드(컬럼/마이그레이션 없음). `SUSPICIOUS_COMMENT_THRESHOLD = 10` 초과 시 의심 플래그(노이즈 프록시임을 인지, 추후 사용자 설정 가능 여지).
- 수동 self-check 체크박스 **UI만 제거**, `set_pr_self_check` 커맨드+바인딩은 deprecated로 유지(빌드/바인딩 churn 회피).
- Codex "self-check 초안" → **"code review"**로 용도 변경: 해당 프로젝트 하네스에 적합한 근본적 구조 문제 검토. 프롬프트는 스킬 레지스트리 편집 가능, **`BINDING_PR_SELFCHECK` 키 보존**(표시명만 변경).
- 카드 → **한 줄 1 PR** 리스트/로우.
- **AC**: PR 로우에 코멘트 수 + 임계 초과 플래그 / code-review 액션이 레지스트리 프롬프트로 gated draft 생성 / 레이아웃 한 줄 1 PR.

### B5 · UX 전환 애니메이션 정규화
- 표준 전환 토큰을 화면 전환 + 주요 인터랙션에 적용, 로딩 상태 일관화(A7b 기반).
- **AC(변경 파일 한정)**: 화면 전환이 공유 전환 사용 / 변경된 파일에 ad-hoc 애니메이션 값 잔존 없음(미변경 파일의 기존 값은 범위 밖).

---

## ADR

- **Decision**: 사용자 피드백 ~12개 영역을 2단계(A 버그/정합성 → B UX 리팩터) PR 단위 플랜으로 구조화.
- **Drivers**: 실제 블로킹 버그 우선, 레일 경계 보존, executor 무질문 실행 가능 명세, feature/refactor 분리(AGENTS.md).
- **Alternatives considered**: 전부 한 플랜(혼재 금지 위반) / 블로킹 버그만(UX 부채 잔존) — 모두 기각.
- **Why chosen**: 2단계 게이트가 위험 격리 + INVARIANT 준수 + 점진 검증에 최적.
- **Consequences**: A1은 캘린더 재연결 필요(구 토큰 403). B4 임계값 첫 보정은 블라인드. cmux 인디케이터는 best-effort(포맷 변경 시 조용히 degrade).
- **Follow-ups**: B4 코멘트 임계 사용자 설정화, 노션 데이터소스(신 API) 정식 지원 검토, cmux CLI 포맷 변화 모니터링.

## 검증 (각 PR 종료 시)
- Rust: `cargo test` + `cargo clippy`. 프런트: 타입체크 + 린트. Tauri: `pnpm tauri dev` 부팅 확인.
- (PATH: cargo는 `$HOME/.cargo/bin` export 후 실행. push는 dev만, main은 PR-only.)
- Phase 종료 시 INVARIANTS 7개 별도 reviewer 패스(self-approve 금지).

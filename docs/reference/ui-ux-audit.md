# UI/UX Balance Audit — Phase 18 (24)

> 정본 디자인 = `DESIGN.md`(Cohere white editorial). 이 문서는 Phase 18에서 **객관적
> conformance 수정은 코드로 반영**하고, **주관적·시각 밸런스 항목은 펀치리스트로 분리**한
> 결과다. 펀치리스트 항목들은 **실행 중인 GUI + 디자인 안목**이 필요하므로 사용자가
> `/design-review`(gstack, 라이브 앱)로 구동해 확정·반영하는 것이 정직한 처리 방식이다.
>
> 작성: Phase 18 구현 시 정적 코드/스타일 감사 기준. 픽셀 검수는 포함하지 않는다.

---

## 1. 이번 Phase에서 코드로 반영한 객관적 수정 (DONE)

| 항목                     | 무엇                                                                                                                    | 근거(DESIGN.md)                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 위험/오류 텍스트 색 통일 | `#b30000`/`#b23a1f`/`#c4502f` 3종 빨강 → 단일 토큰 `--color-wr-danger`(=Error Red #b30000)                              | "Error Red(#b30000)" 단일 정의. 한 의미에 색 3종은 비일관. |
| pale wash 토큰화         | `#ffe7e0`/`#fdeae4`→`--color-wr-danger-soft`, `#e3f1ec`→`--color-wr-success-soft`, `#e0b4a8`→`--color-wr-danger-border` | 값은 보존(시각 무변경), 토큰 참조로 일관성 확보.           |
| 코드 칩 radius off-scale | `.st-hint code` `border-radius: 3px` → `var(--radius-xs)`(4px)                                                          | Shapes radius scale 최소값 = 4px(xs). 3px는 스케일 밖.     |
| 죽은 컴포넌트 제거       | `RootPalette.tsx` 삭제(미import dead code, Raycast식 ⌥Space/⌘1 stale 힌트)                                              | 폐기된 Raycast 방향 잔재. 사용자 capability 0 손실.        |
| 네비 그룹 정리           | 팔레트를 의미 그룹(운영/리뷰/코드/외부)으로 묶음                                                                        | 평면 13개 나열 → 위계화(보수적, 항목 삭제 없음).           |
| 금지 컴포넌트 검사       | announcement-bar/trust-logo-strip/blog-filter-chip/research-table/footer-newsletter = **0건**                           | 데스크톱 셸에 웹/마케팅 컴포넌트 금지 — 위반 없음(확인됨). |

---

## 2. 중복/오버랩 감사 (consolidation #4)

| 표면                                                                     | 판정                                                                                                          | 처리                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RootPalette.tsx` vs `CommandPalette.tsx`                                | **진짜 중복(dead)**                                                                                           | RootPalette 삭제. 네비는 CommandPalette 단일 경로.                                                    |
| CaptureBoard `TodayRail`(decide/curate) vs `TodayView`(execute/overview) | **의도된 오버랩** — 같은 `useToday` 데이터, 다른 역할(보드=정리, Today=운영 콕핏; TodayView.tsx:43 주석 명시) | **삭제 안 함.** 둘 다 capability. 팔레트 "운영" 그룹으로 묶어 인접 표현.                              |
| Today vs Timeline                                                        | **오버랩** — Today=집계 콕핏, Timeline=시간축 아젠다                                                          | 삭제 안 함. "운영" 그룹으로 인접화. 라이브 검수 시 두 뷰의 정보 중복 비율 점검 권장(아래 펀치리스트). |
| Q1/캘린더가 여러 뷰에 등장(Board/Today/Timeline)                         | **의도된 read 합성**(각 뷰 목적별 슬라이스)                                                                   | 삭제 안 함. 데이터 SSOT는 단일(signals/calendar).                                                     |

**원칙:** 진짜 dead/중복만 제거. 오버랩-by-design은 그룹/라벨로 정리하되 capability는 보존(보수적).

---

## 3. 주관적 펀치리스트 (USER가 `/design-review`로 구동·확정)

각 항목 = `뷰 → 관찰 → 제안 수정`. 라이브 GUI + 디자인 안목 필요.

### 전역 / 셸

- **헤더 9종 분산** → 각 뷰가 자기 헤더 클래스(`tl-head`/`wk-head`/`rt-head`/`jobs-head`/`pr-head`/`wt-head`/`hm-head`/`skl-head`/`st-head`)를 따로 정의. 스페이싱·타이포·back 버튼 정렬이 미세하게 다를 수 있음 → **공용 `view-head` 컴포넌트/클래스로 통일**(높이·패딩·타이틀 스케일·back 버튼 hit area 1벌). DESIGN.md heading scale 일관성.
- **암묵적 스타일 공유** → `RoutineTrackingView`가 `RetroView`의 `.rt` 스코프(`.rt-head`/`.rt-back`/`.rt-title`/`.rt-tabs`)를 **의도적으로 재사용**(충돌 아님). 단 한쪽 헤더 스타일을 바꾸면 다른 쪽도 변함(암묵적 결합). 위 "헤더 9종 통일"로 공용 `view-head`를 도입하면 이 결합도 자연 해소됨.
- **view 전환 모션** → 이번에 `.view-shell` fade+rise(0.16s) 추가. 라이브에서 너무 약/강한지, board 촤라락(fan-out)과 겹쳐 어색하지 않은지 검수. `prefers-reduced-motion`은 이미 무효화 처리됨.
- **AgentStatusBar 아래 뷰 높이** → 여러 뷰가 `height: 100vh`라 상태바(~30px)만큼 하단이 잘림(현재 `.view-shell overflow:hidden`이 clip — 기능 영향 없음). 라이브에서 하단 콘텐츠 잘림 체감되면 뷰들을 `height:100%`/flex로 전환 권장(별도 작업, 본 Phase 범위 밖).

### Capture Board

- INBOX/매트릭스/Today/Routines 4영역 폭 비중이 DESIGN.md "2×2가 가로 60%+"를 라이브에서 충족하는지(좁은 창에서 매트릭스가 충분히 큰지) 검수.
- postit-card Media Lift 그림자(`0 8px 22px rgba(15,20,40,.12)`)가 흰 캔버스에서 과하지 않은지(DESIGN.md 한정 예외).

### Today / Timeline

- 두 뷰의 "오늘 이벤트/Q1" 표현이 시각적으로 충분히 구분되는지(역할 차이가 한눈에 읽히는지). 안 읽히면 헤더 카피/아이콘으로 역할 라벨 강화.
- Work Debt 스트립 숫자 타이포 위계(Mono vs Sans) 일관성.

### PR Radar / Worktree / Jobs

- 버킷/리스트 행 높이·구분선이 research-list류 "rule-separated" 위계와 맞는지(과한 카드화 지양 — DESIGN.md "every section card-based 금지").
- Jobs(807줄)·Worktree(650줄) 밀도 높은 뷰에서 섹션 간 수직 리듬(8px base) 점검.

### Retro / Weekly / Routine Tracking

- 차트/랭킹 색이 사분면 색(q1..q4)과 의미 충돌하지 않는지(색만으로 의미 전달 금지 — 라벨 병기 확인).
- 히트맵/streak 색 강도 스케일이 muted→accent 한 방향인지.

### Hermes / Skills / Settings

- 폼 입력 보더·radius가 `contact-form-card`(thin gray, 12–16px padding) 규격과 맞는지.
- Settings 신규 "네비게이션/단축키" 블록의 keymap 2열 그리드가 좁은 창에서 1열로 잘 접히는지(이미 `@media max-width:720px` 처리, 라이브 확인).

### 잔여 하드코딩 색 (라이브 판단 후 토큰화)

- `#c9c7c0`(card 좌측 border-left, styles.css 그 1곳) — DESIGN.md 미정의 회색. muted accent 의도면 `--color-wr-subtle`/`--color-wr-border` 중 의미 맞는 토큰으로. 시각 영향 있어 라이브 확인 후 교체 권장.
- `#fff`(다수) — 다크 배경 위 흰 텍스트/아이콘. DESIGN.md 정합(white-on-dark)이므로 유지. 토큰화는 선택.

---

## 4. 검증 메모

- 본 감사는 **정적**(코드/스타일 grep + 컴포넌트 구조). 픽셀·간격·위계의 최종 판정은 라이브 GUI 필요.
- 객관적 수정(§1)은 typecheck + build green으로 회귀 없음 확인.
- §3 펀치리스트는 `/design-review`(gstack) 또는 `pnpm tauri dev` 수동 검수로 사용자가 구동.

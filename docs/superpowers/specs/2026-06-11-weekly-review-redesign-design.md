# Weekly Review 재설계 — Life Wheel Radar + 통합 대시보드 + 회고/보관함 병합

- 날짜: 2026-06-11
- 브랜치: `feat/weekly-review-redesign` (worktree `work-radar-wt/weekly-redesign`)
- 도메인: `docs/areas/frontend-shell.md` (\*View.tsx), `DESIGN.md` §App Surface
- 상태: 설계 승인 대기

## 1. 문제 / 목표

현재 Weekly Review(`WeeklyView.tsx`)는 처리량·PR·루틴·부채 추세만 보여주는 단순 지표
페이지이고, 회고/보관함은 별도 뷰(`RetroView.tsx`, `retro` 나브 아이템)로 분리돼 있다.

목표:

1. **Life Wheel Radar 차트** 추가 — 이번 주 활동이 어느 삶의 영역으로 갔는지 시각화.
2. **전체 대시보드를 더 잘 꾸미기** — 내러티브형 단일 페이지(Concept A)로 재구성.
3. **회고 + 보관함을 Weekly Review 한 페이지에 병합** — `RetroView` 흡수, `retro` 나브 제거.
4. **주차 네비게이션** — 페이저(`‹ ›`) + 가로 스크러바 타임라인 + "이번 주로" + 키보드 `←/→`.
   선택한 주가 페이지 전체(휠·지표·회고)를 구동.

파괴적 변화 허용 — `RetroView`/`retro` 라우트 제거 포함.

## 2. 범위 결정 (확정됨)

- **Radar 의미** = 활동량 자동 집계 (수동 만족도 입력 아님). 추가 입력 UI 없음.
- **기간 그레인** = 주만 (MVP). 월/분기 토글은 deferred follow-up.
- **네비게이션** = 페이저 + 스크러바 둘 다 + 키보드.

## 3. 핵심 원칙: 신규 백엔드 IPC 0개

모든 데이터는 기존 커맨드 재사용. tauri-specta 바인딩 변경 없음 → `bindings.ts` drift 0.

| 영역 | IPC | 비고 |
|------|-----|------|
| KPI / PR / 루틴 / 부채추세 | `weeklyReview(endDate)` | 선택 주의 끝 날짜로 재파라미터화. 이미 7일 윈도우. |
| Life Wheel Radar | `listCompleted(start,end)` | 클라이언트에서 Life Wheel area별 그룹핑. |
| Radar 4주 평균 오버레이 | `listCompleted(start5wAgo,end)` 1회 | 주 단위로 버킷팅. |
| Radar 축/색 | `getLifeWheelTags()` | enabled 태그 = 축, color = 시리즈 색 후보. |
| 회고 랭킹/타임라인 | `listCompleted(start,end)` | `.impact`/`.regret` 플래그로 필터. Radar와 동일 데이터 공유. |
| impact/regret 토글 | `setSignalImpact`, `setSignalRegret` | 기존 mutation 재사용. |
| 보관함 | `listArchivedSnoozed()` | 주차 비종속(글로벌). 아코디언에. |
| 복원 | `restoreSignal` | 기존. |

> 검증 필요: `weeklyReview`가 임의 과거 endDate를 받는지(현 시그니처상 받음). 첫 슬라이스에서
> 실 IPC로 확인.

## 4. 컴포넌트 구조

```
WeeklyView.tsx (통합 surface, RetroView 흡수)
├─ useWeekNav()                 # 선택 주 상태(offset), 페이저/스크러바/키보드 공용
├─ <WeekNavigator>             # 헤더 아래 sticky: 페이저 ‹ › + "이번 주로"
├─ <WeekScrubber>              # 가로 타임라인 스트립(최근 N주, 주별 활동 스파크, 클릭 점프)
├─ <MomentumSection>          # KPI 타일 + 루틴 바 (weeklyReview)
├─ <LifeWheelRadar>           # recharts RadarChart, 선택주 vs 4주평균
├─ <DebtTrend>                # 기존 7일 부채 미니 차트 (weeklyReview.debtTrend 재사용)
├─ <ReflectionSection>        # 회고: 고임팩트/하지말걸 랭킹 + 완료 타임라인
└─ <ArchiveAccordion>         # 보관함: 접힌 <details>, 복원 버튼
```

각 유닛은 단일 책임 + props로 `weekRange`(start,end)와 데이터를 받는 순수 표현 컴포넌트
지향. `useWeekNav`만 상태를 가짐. 데이터 패칭은 기존 react-query 훅(`useWeeklyReview`,
`useCompleted`, `useArchivedSnoozed`, `useLifeWheelTags`)을 선택 주 범위로 호출.

### 4.1 useWeekNav

- 상태: `weekOffset`(0 = 이번 주, 음수 = 과거). 현재 주가 상한(미래 비활성).
- 파생: `{start, end}` ISO 날짜(월요일 시작 가정 — 기존 weeklyReview 경계와 일치시킴).
- 액션: `prev()`, `next()`(offset 0이면 no-op), `goto(offset)`, `reset()`.
- 키보드: `←`/`→` (입력 포커스/패널 오픈 시 게이트 — frontend-shell 키보드 관례 따름).

### 4.2 LifeWheelRadar (recharts)

- **축은 런타임 계산.** Life Wheel 팔레트는 사용자가 태그를 추가/삭제/비활성할 수 있으므로
  축 집합과 개수를 하드코딩하지 않는다. `getLifeWheelTags()`의 `enabled === true` 태그를
  `id` 기준 안정 정렬해 축으로 사용. 태그 개수 N은 가변.
- 미설정/`area=null` 완료 신호는 **제외**(노이즈 감소, 사용자 확정). "기타" 축 없음.
- **가변 N 처리 (degenerate 가드):**
  - **N ≥ 3** → recharts `<RadarChart>` (정상 폴리곤).
  - **N === 1 또는 2** → 레이더는 폴리곤이 안 되므로 **수평 바 폴백**(축별 count 막대)으로
    렌더. 동일 데이터·동일 토큰, 표현만 교체.
  - **N === 0** (enabled 태그 없음) → "Life Wheel 태그가 없습니다 — 설정에서 추가하세요"
    안내 + 설정 딥링크.
  - **N 과다(라벨 혼잡)** → 라벨은 축 끝에 배치하되 긴 라벨은 말줄임. 차트 크기는 고정,
    축 각도는 `360/N` 자동. (별도 상한 없음 — 팔레트가 곧 상한.)
- 시리즈 2개: 선택 주(녹색 fill), 직전 4주 평균(회색). `<Radar>` 2개 + `<PolarGrid>` + `<PolarAngleAxis>`.
- 값 = 해당 area의 완료 신호 수. 정규화: 축별 raw count 표시(툴팁), 폴리곤 반경은
  **선택주+평균 통틀어 max-count** 기준 스케일(두 시리즈 비교 가능하게 공통 스케일).
- 색/타이포는 토큰만. 시리즈 색은 의미색(선택주=green, 평균=muted) 고정 —
  태그별 색(`tag.color`)은 **바 폴백/툴팁 범례에서만** 사용(레이더 폴리곤은 시리즈색).
- 빈 주(완료 0, N≥1) = 축은 그리되 폴리곤 0 반경 + "이 주에 완료한 항목 없음" 안내.

## 5. 네비게이션/라우팅 변경 (파괴적)

- `src/lib/nav.ts`: `retro` NAV_ITEM **제거**. `weekly` 유지(라벨 "Weekly Review").
  - `routines` 나브는 유지(별개 뷰). review 그룹에 weekly만 남음 → 그룹 단순화.
- `src/App.tsx` `renderView`: `retro` 분기 제거.
- `src/store.ts` `View` 타입: `"retro"` 제거. (저장된 view 상태가 retro면 weekly로 폴백 — 마이그레이션 가드.)
- 키보드 단축키: 기존 `Cmd+5`(retro) 회수 → 미할당 또는 weekly에 흡수. 인접 뷰 슬라이드 순서 재계산.
- `RetroView.tsx` / `RetroView.css` **삭제**. 재사용 로직(랭킹 계산, 타임라인 그룹핑, KindAreaChips
  사용)은 새 섹션 컴포넌트로 이전.

## 6. 디자인 (Cohere white editorial)

- 단일 카드 페이지(max-width ~1100px), hairline 보더, Media Lift(라운드+보더, drop shadow 금지).
- 히어로 2단 그리드: 좌 Radar 카드 / 우 모멘텀(KPI+루틴).
- 토큰: `--color-wr-*`, `--color-q1/q2`, `--wr-density-*`, `typo-*` 유틸만. raw hex/rgb 금지.
- CSS 네임스페이스 `.wk-*` (WeeklyView.css에 통합, RetroView.css의 `.rt-*`는 필요분만 이식).
- 모션: `prefers-reduced-motion` 존중, transform/opacity 위주. 주차 전환 시 과한 애니메이션 지양.
- mockup 참조: `mockups/weekly.html` Concept A (페이저+스크러바 반영본).

## 7. 에러/엣지

- `weeklyReview`/`listCompleted` 실패 → 기존 react-query 에러 표면 패턴(AppError envelope) 따름.
- 미래 주 네비 차단(next 비활성, offset 0 상한).
- 데이터 없는 과거 주 → 빈 상태 안내(휠/회고/지표 각각).
- 보관함 비었을 때 아코디언 카운트 0 + 빈 안내.
- 스크러바 N주 범위는 데이터 존재 범위로 제한(가장 오래된 신호 이전 비표시).

## 8. 테스트

- `useWeekNav` 순수 로직: offset 경계(미래 차단), reset, goto, start/end 날짜 계산 — vitest.
- Radar 그룹핑 헬퍼(신호[] + enabled 태그[] → 축별 count) 순수 함수 — vitest.
  케이스: null/미설정 제외, 비활성 태그 제외, 안정 정렬, 공통 max 스케일,
  **N=0/1/2/3+ 분기**(0=안내, 1·2=바 폴백 신호, 3+=레이더), 추가/삭제로 N 변동 시 축 재계산.
- 회고 랭킹/타임라인 그룹핑 헬퍼(이미 RetroView에 있으면 이전 + 테스트 추가).
- 컴포넌트 렌더 스모크(빈 상태 포함) — 기존 testing 관례.
- 게이트: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + `bindings.ts` drift 0(백엔드 무변경이라 자명) + `pnpm tauri dev` 부팅.
- 라이브 비주얼 스모크(주차 페이징·휠 갱신·회고 토글·보관함 복원)는 native WKWebView → 사용자/cmux.

## 9. 슬라이스(구현 순서)

1. **S1 데이터 검증 + useWeekNav**: `weeklyReview` 과거 endDate 동작 확인, `useWeekNav` + 테스트.
2. **S2 LifeWheelRadar**: recharts 차트 + 그룹핑 헬퍼 + 빈 상태.
3. **S3 통합 셸**: WeeklyView 재구성(히어로 2단 + 모멘텀 + 부채), 네비게이터/스크러바 배선.
4. **S4 회고 흡수**: ReflectionSection(랭킹+타임라인) + impact/regret 토글, 선택 주 연동.
5. **S5 보관함 아코디언**: ArchiveAccordion + 복원.
6. **S6 라우팅 정리(파괴적)**: retro NAV/View/렌더/단축키 제거, RetroView 삭제, View 폴백 가드.
7. **S7 게이트 + critic 별도 패스** + 라이브 스모크 핸드오프.

## 10. 비목표 (deferred)

- 월/분기 그레인.
- 수동 만족도 입력형 Life Wheel.
- 새 백엔드 집계 IPC(월/분기 도입 시 필요).
- 신규 회고 데이터 프로듀서.

# Routine Tracking Editorial Redesign Design

## Outcome

루틴 트래킹을 반복 카드 목록에서 기간별 성과를 빠르게 읽는 편집형 성과표로 바꾼다. 사용자는
화면을 열자마자 `전체 이행률 → 완료 occurrence → 현재 streak → 개별 루틴 추이` 순서로
읽을 수 있어야 한다.

## Scope

- `RoutineTrackingView.tsx`의 표시 계층과 프런트 파생 지표
- `RoutineTrackingView.css`의 Cohere white editorial 레이아웃
- 요약 지표와 완전한 상태를 잠그는 DOM 테스트

기존 `routine_tracking` IPC, query key, 기간 저장, 데이터 순서, 루틴 편집 흐름은 변경하지 않는다.

## Chosen Direction

### 1. Editorial scorecard

상단은 페이지 제목과 기간 선택을 한 줄에 배치하고, 그 아래에 전체 이행률·완료 occurrence·활성
streak 세 지표를 rule로 구분한다. 별도 카드나 새 색상은 만들지 않고 기존 숫자·mono 역할과
hairline을 사용한다.

전체 이행률은 `sum(done) / sum(due)`의 가중 비율이다. 개별 루틴 퍼센트의 단순 평균은 빈도가
다른 루틴을 같은 무게로 취급하므로 사용하지 않는다. `due=0`이면 이행률은 0%로 표시한다.

### 2. Routine rows

개별 루틴은 rounded card 대신 상·하단 rule로 구분된 행이다. 첫 열은 제목·주기·kind/area,
둘째 열은 완료 비율과 progress, 셋째 열은 streak, 마지막 열은 history heatmap을 소유한다.
기존 query 순서를 유지하며 자동 정렬이나 순위화는 하지 않는다.

### 3. History semantics

히트맵은 기존 due occurrence만 표시한다. 완료와 미완료는 색뿐 아니라 각 셀의 접근성 레이블로
구분한다. 90일 구간은 행 내부에서 가로 스크롤하고 전체 페이지 폭을 늘리지 않는다.

### 4. Complete states

- Loading: 요약 지표와 두 개 루틴 행의 최종 지오메트리를 닮은 skeleton
- Error: 제목과 기술 메시지를 분리한 `role=alert`
- Empty: 활성 루틴이 없다는 설명과 기존 보드 진입점을 안내
- No occurrence: 해당 행의 history 영역에 조용한 설명을 유지

## Responsive Behavior

- Desktop: 제목/기간 2열, 지표 3열, 루틴 행 4영역
- `<=900px`: metadata와 rate를 첫 행, streak와 history를 둘째 행으로 재배치
- `<=640px`: 제목과 기간을 세로 배치하고 지표는 3열을 유지하되 숫자와 레이블을 축약하지 않음

스크롤 소유권은 기존 `.rt-scroll`에 남기고 `min-height: 0` 계약을 명시한다.

## Accessibility and Motion

- 기간 버튼의 `aria-pressed`를 유지한다.
- 요약은 `aria-label`이 있는 별도 영역으로 노출한다.
- progress는 숫자를 항상 병기하고 bar는 장식 요소로 처리한다.
- history 셀마다 날짜와 완료 상태를 `aria-label`로 제공한다.
- motion은 progress 폭과 loading opacity에만 사용하고 reduced-motion에서 제거한다.

## Validation

- DOM 테스트로 가중 이행률, 완료 occurrence, 활성 streak, 행 접근성 레이블을 검증
- `pnpm typecheck`, `pnpm lint`, 관련 Vitest, frontend ownership/class/design-token guards,
  `pnpm build`, `npx react-doctor@latest --verbose --diff`
- 실제 Tauri 앱에서 1507x768 상당 데스크톱과 기본 좁은 창을 확인하고 7/30/90일 기간 선택을
  데이터 변경 없이 전환

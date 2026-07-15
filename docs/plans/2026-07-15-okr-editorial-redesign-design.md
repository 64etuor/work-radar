# OKR Editorial Redesign Design

## Outcome

Mission / OKR 페이지를 현재 기능과 데이터 흐름을 유지한 채, `DESIGN.md`의 Cohere white
editorial 앱 표면으로 다시 정돈한다. 사용자가 페이지를 열었을 때 `미션 → 현재 분기 상태 →
주간 기록 또는 분기 목표` 순서로 읽히고, Objective와 KR은 반복 카드가 아니라 목표 문서처럼
스캔되어야 한다.

## Scope

- `src/components/MissionView.tsx`와 `src/components/MissionView.css`의 정보 구조와 스타일
- `src/components/okr/ObjectiveCard.tsx`, `WeeklyCheckInPanel.tsx`, `HorizonShelf.tsx`의 표시 위계
- Mission 전용 레이아웃·카피 회귀 테스트

데이터 모델, Tauri IPC, query hook, 저장 방식, Dialog/Popover 계약은 변경하지 않는다.

## Direction

### 1. Editorial header

미션 문장을 가장 넓은 영역에 두고, 우측에는 `전체 진척`과 `분기 경과`만 숫자로 배치한다.
액션은 그 아래 한 줄로 묶어 미션 문장과 경쟁하지 않게 한다. 흰 캔버스, hairline rule,
display/body/mono 역할 분리를 그대로 사용하며 새 색상이나 그림자를 만들지 않는다.

### 2. Season navigation

분기 선택, 세 개의 탭, 이번 주 체크인 상태를 하나의 sticky navigation row로 묶는다.
기존 pill 컨테이너 대신 얇은 하단 rule과 활성 탭 underline을 사용해 연구 문서 같은 리듬을
만든다. 탭 문구는 `주간 기록 / 분기 목표 / 장기 목표`로 한국어를 일관되게 쓴다.

### 3. Objective document sections

각 Objective에 `O-01` 형태의 순서를 부여하고, full-box card보다 상·하단 rule과 열린 여백으로
구분한다. 제목, 연결 정보, 진행 정보, KR 순서가 고정되며 progress는 숫자와 bar를 함께 써서
색상에만 의존하지 않는다. KR의 인라인 편집·루틴 연결·자신감·삭제 동작은 그대로 유지한다.

### 4. Complete states

초기 로딩에는 실제 레이아웃 크기를 닮은 skeleton rows를 표시한다. 오류는 기술 메시지를
보존하되 제목과 본문을 분리한다. Objective가 없으면 `첫 분기 설계`라는 시작 맥락과 두 기존
진입점(새 Objective, 이전 분기 이월)을 함께 보여준다.

### 5. Responsive behavior

- Desktop: editorial header 2열, navigation 3영역, Objective 3영역 header
- Tablet (`<=980px`): header와 Objective 위계를 세로로 쌓고 KR을 읽기 순서로 재배치
- Mobile (`<=720px`): 액션과 분기 선택을 전폭으로, 탭은 가로 스크롤 가능하게 유지

모든 스크롤 소유권은 기존 `.mission-scroll`에 남기고 `min-height: 0` 계약을 보존한다.

## Accessibility and motion

- 탭은 기존 `role=tablist`, `aria-selected` 계약을 유지한다.
- 진척과 상태는 텍스트를 병기한다.
- 로딩 상태는 `role=status`와 읽을 수 있는 레이블을 제공한다.
- motion은 hover/focus와 로딩 상태에만 사용하고 `opacity`만 애니메이션한다.
- 기존 focus-visible, overlay-stack, Dialog focus restoration 계약은 변경하지 않는다.

## Validation

- Mission 레이아웃·카피 테스트를 red → green으로 실행
- `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, `pnpm check:design-tokens`,
  `pnpm check:frontend-ownership`, `pnpm build`
- `npx react-doctor@latest --verbose --scope changed --base HEAD`
- Tauri 앱을 실제로 실행해 기본 750px과 데스크톱 폭 상당 창에서 탭과 Objective/KR을
  시각 QA하고, 설정된 최소 폭 560px의 레이아웃 계약은 반응형 테스트로 확인

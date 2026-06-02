# 타이포그래피 규율 (App Surface Type)

정본: `DESIGN.md` §App Surface Type(역할 표) + `src/styles/typography.css`(`@utility typo-*` 레시피) + `src/styles/tokens.css`(`--text-*`/`--leading-*`/`--tracking-*` 토큰). 2-레이어: `@theme`=재료, `@utility typo-*`=완성 레시피(size+weight+line+tracking 묶음).

## 규칙

- 표준 텍스트 스타일은 `typo-*` 시맨틱 유틸리티(`src/styles/typography.css`)를 쓴다.
- raw `text-*` + `font-*` + `leading-*` + `tracking-*`를 손으로 조합하지 않는다.
- arbitrary 타이포 값(`text-[15px]`, `leading-[22px]`, `tracking-[-0.01em]`)을 쓰지 않는다.
- `<Text>`/`<Heading>` 래퍼는 시맨틱 마크업/반복 패턴에 이득이 있을 때만(선택, 현재 미도입).
- shadcn/ui 컴포넌트(`CardTitle`/`DialogTitle`/`FormDescription` 등)는 `className="typo-*"`로 타이포를 받는다 — 해당 컴포넌트가 이미 올바른 타이포를 정의한 경우 제외.
- `typo-*`는 타입(size/weight/line/tracking)만 — 색은 별도 토큰 유틸(`text-foreground` 등).

## 카스케이드 주의 (shadcn 기본 클래스 충돌)

`@utility typo-*`는 컴파일된 CSS에서 일부 빌트인 유틸리티(예: `text-base`, `leading-none`)보다 **앞에** 정렬될 수 있다. 동일 specificity에서는 뒤에 온 규칙이 이긴다 → 기본 타입 클래스를 가진 shadcn 프리미티브(예: `CardTitle`의 `text-base leading-none`) 위에 `typo-*`만 얹으면 **기본 클래스가 typo를 덮어쓸 수 있다**. 채택 전 **계산된 값(브라우저 DevTools / 해석된 cascade)으로 실제 적용을 확인**하라 — 이것이 정본 검증법. (dist CSS 바이트 오프셋 비교는 빌드마다 위치가 바뀌어 fragile하므로 1회성 진단으로만.) 충돌하는 사이트는 기본 타입이 정리될 때까지 arbitrary 클래스로 두고 점진 이관한다(`AddProjectForm`의 `CardTitle`이 그 예 — defer됨).

## 점진 채택

기존 arbitrary `text-[NNpx]` (~99곳)은 legacy. 닿는 김에 기회적으로 `typo-*`로 교체하되, 이 정합성만을 위한 광범위 리팩터 PR은 만들지 않는다(한 PR=한 관심사). 드문 1회성 크기(`44px`/`22px`/`9px`)는 역할이 없으면 arbitrary 유지. lint/CI 강제는 이번 작업 범위 밖(향후 follow-up 가능).

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

## 채택 상태 (전면 채택 완료 — 2026-06-02)

시맨틱 텍스트 요소(span/div/p/label 등 경쟁 base 타입 클래스가 없는 콘텐츠 텍스트)는 **전부
`typo-*`로 채택 완료**. 신규 콘텐츠 텍스트도 arbitrary 대신 `typo-*`를 쓴다. 공유 컴포넌트
(`SettingsKit`의 `SectionLabel` 등)는 컴포넌트 내부에서 `typo-*`를 정의해 사용처 전체를 정합화한다.

**의도적으로 arbitrary로 남긴 부류**(typo-\* 강제 금지 — 회귀/미스매치):

- **컨트롤 프리미티브**(`<Button>`/`<SelectTrigger>` 등 `rounded-full text-[12px]`류): 컴포넌트 자체
  `text-sm`/`text-base`와 cascade 충돌 → 계산값이 의도와 달라질 수 있음. 반복되는 버튼 크기 패턴은
  typo role이 아니라 **Button size variant**로 정규화하는 게 옳다(별도 follow-up). 그때까지 arbitrary 유지.
- **뱃지/pill/코드**(`KindBadge`의 `text-[10px] leading-none`, `<code>`, mono 비-role): `leading-none`이
  의도적이거나 매칭 role 없음.
- **role 없는 1회성 크기**(`44px`/`22px`/`9px`, `13px+font-medium` 라벨 등): 표에 역할이 없으면 arbitrary 유지.

lint/CI 강제는 범위 밖(향후 follow-up 가능).

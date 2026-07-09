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

**(2026-06-03 업데이트) `cn()` 경유 시 해소됨.** `cn()`(= `twMergeTypo`)이 `typo-*`를 font-size/
leading/font-weight/tracking/font-family 충돌 그룹으로 인식하므로, `cn("text-base …", "typo-title-md")`는
`typo-title-md`가 이긴다(빌트인 strip, 컴파일 cascade 순서 무관). 따라서 `cn`을 통해 className을 합치는
프리미티브/소비처는 `typo-*`를 그냥 얹으면 적용된다. ⚠️단 `cn` **밖**에서 raw 문자열로 직접 결합한
경우(`class="text-base typo-title-md"`)는 여전히 merge가 적용되지 않아 cascade에 의존 — `cn` 사용 권장.
정본 동작: `src/lib/tw.ts` + `src/lib/tw.test.ts`.

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
- **role 없는 1회성 크기**(`44px`/`22px`/`9px` 등): 표에 역할이 없으면 arbitrary 유지.
  (2026-07-09: `13px+font-medium` 라벨은 반복 role로 판명 → `typo-label-md` 신설·스윕 완료.
  새 role은 **소비처가 여럿이고 cascade 충돌이 없을 때만** 만든다.)

## 새 role 추가 절차

`@utility typo-x`를 `src/styles/typography.css`에만 추가하고 **`src/lib/tw.ts`의 `TYPO_SUFFIXES`를
잊으면 실패가 조용하다** — `cn()`이 그 role을 충돌 그룹으로 못 알아봐 병합하지 않고, 함께 온
빌트인(`text-sm` 등)이 cascade로 이긴다. 컴파일된 CSS를 보기 전엔 안 보인다.
`src/lib/tw.test.ts`의 패리티 테스트가 두 목록의 일치를 강제한다.

순서: `typography.css`(레시피) → `tw.ts`(`TYPO_SUFFIXES`) → `DESIGN.md` §App Surface Type(역할 표)
→ 스윕 → `pnpm check:design-tokens --update-baseline`(baseline은 단조 감소만 — 늘면 잘못한 것).
토큰은 값이 같으면 재사용한다(`typo-label-md`/`typo-body-strong`는 `--text-body-md`를 공유).

## 강제 (design quality gate)

`scripts/check-design-tokens.mjs`가 R1(상태이모지)·R2(off-token 색)·R3(arbitrary 타이포)를
pre-commit + CI에서 강제한다. R3의 의도적 예외(컨트롤 프리미티브 등 전환 부채)는
`scripts/design-gate-baseline.json` **ratchet baseline**으로 추적 — 신규 위반만 차단되고
baseline은 단조 감소만 한다(`--update-baseline`이 유일한 증가 경로, diff로 리뷰). 영구
off-brand 예외는 스크립트 상단 `IGNORE` 상수에 사유와 함께 둔다. 정본:
`docs/superpowers/specs/2026-06-03-design-quality-gate-design.md`.

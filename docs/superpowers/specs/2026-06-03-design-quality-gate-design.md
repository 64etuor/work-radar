# Design Quality Gate (P1) — Spec

작성일: 2026-06-03
상태: 승인 대기 (brainstorm 완료, plan 미작성)
관련: `docs/areas/typography.md`, `docs/areas/shadcn-migration.md`, `DESIGN.md`

## 1. 문제

이번 타이포그래피/디자인-리뷰 세션은 arbitrary 타이포·off-token 색·이모지 상태마커를
**손으로** typo-\*·`--color-wr-*`·lucide로 정합화했다. 그러나 그 정합을 **유지하도록 강제하는
것이 아무것도 없다**:

- `typography.md`가 명시: "lint/CI 강제는 범위 밖(향후 follow-up 가능)."
- 기존 디자인 규율 가드(`check-frontend-ownership`, `check-classname-regression`)는
  **pre-commit에만** 배선돼 있고 **CI(`ci.yml`)에는 없다**. CI는
  `format:check`/`typecheck`/`lint`/`test`/`build`만 실행한다.
- 이 환경은 husky를 `--no-verify`로 우회하는 일이 루틴이라, guard가 통째로 건너뛰어지고
  PR 단계에서도 잡히지 않는다.

→ 드리프트(arbitrary 타이포 재유입, raw 색, 이모지 마커)가 **재발해도 자동으로 막히지 않는다.**

## 2. 목표 / 비목표

**목표**

- 이번 세션이 박멸한 3종 드리프트를 **코드 가드 + CI 게이트**로 박제한다.
- 게이트는 **지금 즉시 green**(현 트리에 NEW 위반 0). 전환 부채(버튼 등)는 ratchet로 점진 축소.
- 기존 guard 2종의 **CI 구멍을 함께 봉합**한다.

**비목표 (YAGNI / 별도 PR)**

- 버튼 ~58곳의 size-variant 정규화 (= P4, 별도 PR). 본 P1은 그것을 *허용·추적*만 한다.
- 토큰/프리미티브 확장 (= P3). 본 가드는 현재 토큰화된 축(타이포/색/이모지)만 강제.
- DESIGN.md 정합 감사 (= P2, 병렬 읽기전용).
- ESLint 커스텀 플러그인/stylelint 신규 도입 — 기존 `scripts/check-*.mjs` 노드 가드
  패턴을 확장한다(가장 작은 변경; 새 빌드 의존 0).

## 3. 아키텍처

### 3.1 기존 패턴 재사용

`scripts/check-frontend-ownership.mjs`의 구조를 그대로 따른다:

- **순수 함수** `export async function checkDesignTokens(root)` → `string[]` 실패 목록 반환.
- **CLI main()** — `import.meta.url` 가드, 실패 시 stderr 출력 + `process.exit(1)`.
- **단위테스트** `scripts/check-design-tokens.test.mjs` (`node --test`), 픽스처 기반.
- 파일 walk는 `check-classname-regression.mjs`의 `ROOTS=["src"]` / `EXTS` / `SKIP` 동일 규약.

### 3.2 가드 3종 (규칙)

각 위반은 `{rule, file, line, snippet, token}` 형태로 수집되고, fingerprint로 baseline·allowlist
판정을 거친다.

**R1 — 이모지 상태마커 (strict, baseline 기대값 0)**

- 컴포넌트 소스(`.tsx`/`.ts`/`.jsx`/`.js`)의 **문자열 리터럴/JSX 텍스트**에서 상태마커 이모지
  blocklist 검출: `🔴 🟢 🟡 🟠 🔵 ⚪ ⚫ ✅ ❌ ⚠️` 등(상태 의미 이모지에 한정 — 전체 이모지 금지가
  아님, false-positive 회피).
- 근거: FINDING-D3/D3b가 제거한 부류. on-brand UI(lucide 아이콘 + 토큰 색)로 대체.

**R2 — off-token 색 (strict, 소수 baseline 가능)**

- `className`/`class` 문자열 안에서 `bg-white`·`bg-black`·`text-white`·`text-black`(토큰 대체
  가능한 raw 유틸) 및 **hex 색 리터럴**(`#rgb`/`#rrggbb`, arbitrary 클래스 `text-[#..]`/`bg-[#..]`
  포함) 검출.
- 정적 allowlist(§3.4)로 영구 예외 제외(shiki github-light 테마 = 의도적 off-brand).

**R3 — arbitrary 타이포 (ratchet baseline)**

- `className` 문자열 안에서 **타이포 축 arbitrary 값**만 검출:
  - `text-[<length>]` 중 **길이 단위**(`px`/`rem`/`em`)인 것 — `text-[#color]`(색)는 R3 대상 아님(=R2).
  - `leading-[..]`, `tracking-[..]`.
- 콘텐츠 텍스트(금지) vs 컨트롤 프리미티브(허용)를 정규식으로 구분 불가 → **ratchet baseline**으로
  현 전환 부채를 스냅샷하고 NEW 위반만 차단(§3.3).

> R3은 `font-*`/`leading-*`(non-arbitrary, 토큰성) 조합은 잡지 않는다 — typography.md가 금하는 것은
> *arbitrary 값*과 *raw 손조합*이지만, 자동 검출 대상은 명확히 식별 가능한 **arbitrary 값**으로 한정해
> false-positive를 0으로 만든다. raw 손조합 금지는 리뷰/문서 규율로 남긴다(비목표).

### 3.3 Ratchet 베이스라인 (전환 부채)

- 파일: `scripts/design-gate-baseline.json` — fingerprint 배열(정렬·커밋됨).
- **fingerprint** = `` `${rule}|${relFile}|${matchedToken}` `` (라인번호 제외 — 코드 이동에 강건).
  동일 파일 내 동일 토큰 반복은 한 엔트리로 접힘(ratchet엔 충분).
- 게이트 로직:
  1. 현재 위반 집합 V 계산(allowlist 적용 후).
  2. `fingerprint(v) ∉ baseline` 인 v 존재 → **FAIL** ("새 위반: …"). ← 드리프트 차단.
  3. **stale 체크**: baseline 엔트리 중 현재 V에 매칭 안 되는 것 존재 → **FAIL**
     ("baseline이 줄었습니다. `pnpm check:design-tokens --update-baseline` 실행").
     → baseline은 **단조 감소만** 가능(ratchet).
- `--update-baseline` 플래그: 현재 V로 baseline 정확히 재생성(의도적 실행, diff로 리뷰).
  이 플래그가 **유일한** baseline 증가 경로이며, 증가 시 diff가 PR에 노출돼 리뷰어가 인지.

### 3.4 정적 allowlist (영구 예외)

`check-design-tokens.mjs` 상단 상수(프런트오너십의 `MAX_LINES` 맵 idiom):

- `IGNORE_GLOBS`: 영구 off-brand 파일(예: shiki 테마/하이라이터 설정 파일 경로) × rule.
- 영구 예외는 baseline이 아니라 여기에 둔다(전환 부채와 영구 의도를 분리; baseline은 0으로 수렴해야
  의미가 있으므로 "영원히 남을" 엔트리를 섞지 않는다).
- 각 allowlist 엔트리는 `// 사유:` 주석 필수(AGENTS.md: context 없는 예외 금지).

### 3.5 배선

- `package.json`:
  - `"check:design-tokens": "node scripts/check-design-tokens.mjs"`
  - `"test:design-tokens": "node --test scripts/check-design-tokens.test.mjs"`
- **pre-commit** (`.husky/pre-commit`): `pnpm check:design-tokens` 한 줄 추가(기존 가드 뒤).
- **CI** (`.github/workflows/ci.yml`): `frontend` job에 **"Frontend guards"** 스텝 추가 —
  `pnpm check:frontend-ownership && pnpm check:classname-regression && pnpm check:design-tokens`.
  → 신규 가드 + 기존 2종을 한 번에 CI에 올려 구멍 봉합. lint/test 스텝과 독립.

## 4. 데이터 흐름

```
walk(src/**) ──▶ per-line regex(R1/R2/R3) ──▶ raw offenders[]
                                   │
              IGNORE_GLOBS 필터 ───┤  (영구 예외 제거)
                                   ▼
                             violations V[]
                                   │
        baseline.json ──▶ ratchet 판정(new? stale?) ──▶ exit 0 | exit 1(+메시지)
```

## 5. 에러 처리 / UX

- 실패 메시지는 frontend-ownership 가드 톤: 규칙명 + 파일:라인 + 스니펫 + **고치는 법**.
  - NEW 위반: "typo-\* 유틸/`--color-wr-*` 토큰/lucide 아이콘으로 대체. 의도적 예외면
    P4 정규화 대상이거나 `--update-baseline`(전환 부채)·`IGNORE_GLOBS`(영구) 검토."
  - stale: "`--update-baseline`로 baseline을 줄이세요(ratchet)."
- `--update-baseline`는 stdout에 "baseline N→M" 출력.

## 6. 테스트 (행동 변경 = 테스트 필수)

`check-design-tokens.test.mjs` (frontend-ownership.test.mjs 모델):

- R1: 상태마커 이모지 있는 픽스처 → 검출 / 일반 텍스트 → 통과.
- R2: `text-black`·`#fff`·`bg-[#abc]` → 검출 / `text-foreground`·`bg-wr-*` → 통과 / IGNORE_GLOBS
  경로 → 통과.
- R3: `text-[15px]`·`leading-[22px]`·`tracking-[-0.01em]` → 검출 / `text-[#abc]`(색=R3 비대상)·
  `w-[200px]`(비타이포)·`typo-title-md` → 통과.
- ratchet: baseline에 있는 fingerprint → 통과 / baseline 없는 신규 → FAIL / baseline엔 있으나
  코드에 없음(stale) → FAIL.
- 픽스처는 임시 디렉터리 트리로 구성, `checkDesignTokens(root)` 순수 호출.

## 7. 롤아웃 / 검증 (실제 실행 증거)

1. 가드 스크립트 + 테스트 작성 → `pnpm test:design-tokens` green.
2. `--update-baseline` 1회 실행 → 현 전환 부채(버튼 등) 스냅샷 커밋. 이후 `pnpm check:design-tokens`
   = green(NEW 0, stale 0).
3. R1/R2 baseline 엔트리 수 확인(기대: ~0; 있으면 그 자체가 발견 → 보고).
4. 게이트 효과 실증: arbitrary 타이포 한 줄을 임시로 넣어 `check:design-tokens`가 FAIL 하는지 →
   되돌림(증거 캡처).
5. 전체 게이트: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` + 신규 가드 green.
6. critic(opus 별도 패스) ACCEPT 전엔 done 아님.

## 8. 문서 업데이트

- `typography.md`: "lint/CI 강제는 범위 밖" → **"`check:design-tokens` 가드로 강제(R1/R2/R3,
  ratchet baseline)"**로 개정. baseline·allowlist 운용법 한 단락.
- `shadcn-migration.md`: off-token 색/이모지 가드 한 줄 참조.
- `docs/areas/area-map.md`: design-token 가드 라우팅 행 추가(또는 typography 행 보강).
- `docs/decisions.md`: P1 게이트 + CI 구멍 봉합 breadcrumb 한 줄.

## 9. 위험 / 롤백

- **false-positive 위험**: 정규식이 의도치 않은 사이트를 잡으면 게이트가 막힌다 → 단위테스트
  픽스처로 경계 고정 + 첫 `--update-baseline`가 현 트리를 통째로 흡수하므로 도입 시점엔 0 FAIL 보장.
- **롤백**: 순수 가산(신규 스크립트 + CI 스텝 + 1줄 pre-commit). 되돌리면 이전 동작. 앱/Rust/마이그
  레이션/bindings **무변경**(FE 빌드도드 무관, 도구 스크립트뿐).
- **baseline 비대 위험**: `--update-baseline`만 증가 경로 → diff 리뷰로 통제. stale-FAIL가 자동
  축소를 강제.

## 10. 범위 경계 (한 PR = 한 관심사)

이 PR에 포함: 가드 스크립트 + 테스트 + baseline + pre-commit/CI 배선 + 위 문서.
**제외**: 실제 버튼 정규화(P4), 토큰 확장(P3), DESIGN.md 감사(P2). 코드 _동작_ 변경 0
(가드는 도구 레이어; 앱 런타임 무관).

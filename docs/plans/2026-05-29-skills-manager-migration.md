# 스킬 레지스트리 — skills-manager UX 이식 (feature-by-feature)

작성 2026-05-29. 브랜치 `feat/skills-mgr-migration` (worktree). 기준 `dev`.

## 배경

현 `SkillsView`(스킬 레지스트리, Phase 20 #21)는 2-pane(좌 세그먼트 리스트 + 우 편집
패널)에 raw `<pre>` 뷰어로, UX가 빈약하다. 오픈소스 [skills-manager](https://github.com/xingkongliang/skills-manager)
(Tauri+React 스킬 관리 GUI)의 **프레젠테이션 레이어**를 차용해 단계별로 교체한다.

**디자인 컨셉은 work-radar(Cohere white editorial, Tailwind v4 `@theme` `--color-wr-*`,
shadcn) 유지.** skills-manager의 클래스/토큰은 work-radar 토큰으로 매핑한다.

## 차용 원칙 / 레일

work-radar의 데이터 모델·커맨드·INVARIANT는 **그대로 둔다**. skills-manager의 *표현*만 가져온다.

- 외부 스킬(`~/.claude/skills/*/SKILL.md`)은 **디스크 SSOT, 읽기/편집 전용, 실행 없음**(#1/#2).
- 인앱 프롬프트 편집은 codex **제안 내용**만 바꾼다(잡은 여전히 gated + Acceptance). 자동적용 경로 없음.
- `Skill`에 `project_id` 없음(#7) — project vs global은 **표시 순서**일 뿐.

### 차용하지 않음 (deferred — ADR 필요)

skills-manager의 **핵심 모델**(중앙 라이브러리 `~/.skills-manager` → 멀티툴 symlink/copy 동기화,
마켓플레이스/git 설치, 프리셋)은 위 레일(비실행·디스크 SSOT·외부 네트워크는 Rust)과 정면 충돌한다.
이번 마이그레이션 범위 밖. 도입하려면 별도 ADR + 결정 레일 리뷰.

## 증분 (PR 단위 — 한 PR=한 관심사)

- **PR 1 — 프레젠테이션 스왑 (백엔드 무변경).** 2-pane → 헤더(타이틀·카운트·검색·grid/list
  토글·추가) + **카드 그리드/리스트** + **슬라이드오버 Sheet**(편집기/뷰어 호스팅). 상태 배지는
  기존 데이터만으로(enabled·kind·binding·provider). `ui/sheet.tsx` 신규(radix Dialog 기반,
  overlay-stack 마커). **레일 무위반.**
- **PR 2 — 마크다운 렌더.** 외부 `SKILL.md`를 Sheet에서 렌더(현재 raw `<pre>`). 마크다운 렌더러
  의존성 결정 필요. 읽기 전용 표시.
- **PR 3 — 태그 + 필터.** 유일한 스키마 변경: `skill_tags` 매핑(인앱=skill id, 외부=source_path)
  마이그레이션 + set/list 커맨드 + `bindings.ts` 재생성. 태그 필터 pill + Untagged.
- **PR 4 — Diff 뷰어.** 커스터마이즈된 인앱 프롬프트를 코드 상수 폴백과 diff + reset-to-default.
  skills-manager의 sync-diff UX를 work-radar 폴백 모델에 접지.

## PR 1 상세

### 변경 파일

- `src/components/ui/sheet.tsx` **(신규)** — radix Dialog 기반 우측 슬라이드오버. `dialog.tsx`와
  동일하게 `data-wr-overlay-open` 정적 마커 + `Close` + `SheetTitle`. controlled(트리거 없음) 사용.
- `src/components/SkillsView.tsx` — 2-pane → 헤더+카드+Sheet. `segmentSkills`/`providerOf`/
  `InAppEditor`/`ExternalViewer`/`CreatePanel` 로직은 보존, 컨테이너만 교체.
- `src/components/SkillsView.css` — 사이드바/row 클래스 제거, 카드/툴바/섹션 클래스 추가
  (`--color-wr-*` 토큰). 편집기 클래스는 보존.

### Esc 계약 (hard gate) — 실측 결과

- Sheet는 **프로그램적(controlled `open`)** — `DialogTrigger` 없음.
- **실측 발견**: radix는 document에 capture-phase Esc 리스너를 달아 close 시 Content를 즉시
  unmount → window 버블 시점엔 `data-wr-overlay-open` 마커가 이미 사라진다(overlay-stack 결정의
  "마커가 native Esc 버블까지 생존" 전제가 이 radix+React 버전에선 성립 안 함). SkillsView는 비-board라
  창은 안 숨고 board로 bounce했을 뿐 — 재사용 시 board에서 창 hide 위험.
- **수정**: `SheetContent`에 `onEscapeKeyDown={(e)=>e.stopPropagation()}` — radix가 시트 닫는 건
  그대로, Esc가 window까지 못 가게 막아 타이밍-독립적으로 안전.

### 검증 (실행 결과)

- `pnpm typecheck` 0 · `pnpm lint` 0 errors(2 pre-existing warning) · `pnpm vitest run` 194 pass
  (`skillGrouping`/`overlay-stack` 포함). ✅
- **Esc 스모크(Playwright, vite :1430 + Tauri 스텁 주입)**: 팔레트→스킬 뷰→"인앱 프롬프트 추가"로
  Sheet open(마커 present) → Escape → 시트 닫힘 + `hideCalls===[]`(창 hide 미호출) + 스킬 뷰 유지
  (bounce 없음) + window 핸들러 Esc 미수신. ✅
- INVARIANT #1/#2/#7 무위반 — 별도 critic 패스 ACCEPT-WITH-RESERVATIONS → 2건(drag-region·스모크) 해소. ✅

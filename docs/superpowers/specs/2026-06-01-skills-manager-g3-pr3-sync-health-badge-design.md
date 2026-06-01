# G3-PR3 — 스킬 sync 헬스 배지 (#17, 사이드바 divergence rollup)

작성일: 2026-06-01 · 상태: design (approved — autonomous) · ADR: [0006](../../adr/0006-skills-registry-full-manager.md)
선행: G3-PR1(워크스페이스 뷰 #16) · G3-PR2(divergence 감지) · G3-PR2b(vendoring) · G3-PR2c(divergence 해소)
**G3의 마지막 슬라이스 — 완료 시 스킬 매니저 마이그레이션 종료.**

## 1. 문제 / 기대 영향

PR2c로 프로젝트 vendored 카피의 양방향 sync가 완성됐다. 그러나 사용자는 **어느 프로젝트가
드리프트됐는지** 사이드바에서 한눈에 못 본다 — 카드를 열어야 `·다름` 마커(PR2)가 보인다. #17은
사이드바 "프로젝트" 섹션에 **divergence rollup 배지**를 달아, 워크스페이스별·전체 드리프트 수를
글랜서블하게 만든다.

기대 영향: 글랜서빌리티 — "이 프로젝트에 중앙과 다른 카피가 N개 있다"가 사이드바에서 즉시 보인다.
이게 G3의 마지막 조각이다.

## 2. 설계 결정 (autonomous — 선행 PR 패턴 일관)

- **FE 전용, 새 백엔드/커맨드 없음.** divergence **상태 판정은 이미 백엔드**(`divergence.rs`)가
  authoritative하게 수행하고 `SkillDivergence{repoId, status}`로 내려준다(PR2). 배지는 그걸 **repoId로
  그룹·카운트**하는 **표시 전용 집계** — 경로추론이 아니다(PR2의 카드 마커 `buildDivergedPathSet` /
  `g.locations.some(...)`와 동일 패턴). 따라서 PR1의 "Design B 백엔드 집계"(멤버십 *경로* 추론 회피)는
  여기 해당 없음 — 새 커맨드/표/마이그레이션/bindings drift **0**.
- **per-workspace 배지 + 섹션 aggregate.** 각 프로젝트 nav 항목에 diverged 카운트 배지(>0일 때만),
  "프로젝트" 섹션 라벨에 전체 합계.
- **배지는 diverged만.** InSync는 정상 상태라 무배지(노이즈 억제). 카운트는 멤버(스킬) 단위.

## 3. 변경

### 순수 헬퍼 (src/lib/skillEnvNav.ts)

```ts
/** repoId → diverged 멤버 수(G3-PR3, #17 — 표시 전용 rollup). divergences가 상태 단일 출처(C6 —
 *  status는 divergence.rs 판정). in_sync/미수록은 카운트 안 함. buildDivergedPathSet의 카운트 트윈. */
export function buildWorkspaceHealth(
  divergences: SkillDivergence[] | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of divergences ?? []) {
    if (d.status === "diverged") out.set(d.repoId, (out.get(d.repoId) ?? 0) + 1);
  }
  return out;
}
```

전체 합계는 호출부에서 `[...health.values()].reduce((a, b) => a + b, 0)`.

### EnvNavButton 배지 (src/components/SkillsView.tsx)

- optional prop `diverged?: number` 추가. `diverged && diverged > 0`일 때만 count 옆에 coral 배지
  렌더: `<span className="skl-env-diverged" title="중앙과 다른 카피 N개">N</span>`(aria 포함).
- env(provider) 항목은 `diverged` 미전달 → 무배지(divergence는 프로젝트 vendored 카피 전용).

### 사이드바 wiring

- `const health = useMemo(() => buildWorkspaceHealth(divergences.data), [divergences.data])`
  (divergences는 PR2가 이미 `useSkillDivergences()`로 컴포넌트에 들임 — 재사용).
- workspaceNav 렌더에서 각 item의 repoId를 `item.id`(`workspace:<repoId>`)에서 도출
  (우리 id 포맷 — 경로추론 아님) → `health.get(repoId)`를 `diverged`로 전달.
- "프로젝트" 섹션 라벨: 합계 > 0이면 ` · N 다름` 접미.

### CSS (src/components/SkillsView.css)

```css
.skl-env-diverged {
  /* coral 배지 — danger 톤, 작은 pill */
  color: var(--color-wr-danger);
  font: 600 11px var(--font-mono);
}
```

## 4. INVARIANT 체크

- **#1/#2 (잡 spawn 0)** — 순수 표시. 변이/네트워크/잡 없음. ✅
- **#7 (무마이그레이션)** — FE 표시 전용, 표/커맨드/bindings 0. ✅
- **C6 (단일 출처)** — status는 백엔드 divergence.rs, FE는 그룹·카운트만(경로추론 없음). ✅
- **C7 (로그 금지)** — 경로/내용 로그 없음. ✅
- **시각 디자인** — danger 토큰·기존 사이드바 스타일 일관(DESIGN.md). ✅

## 5. 검증 (done-criteria)

- `pnpm vitest run` — `buildWorkspaceHealth` 순수 테스트(빈/undefined·diverged 카운트·in_sync 제외·
  멀티 repo) skillEnvNav.test.ts에 추가.
- `pnpm typecheck` + `pnpm lint`(0 errors).
- **bindings drift 0**(Rust 무변경 — cargo 불요).
- 독립 opus critic(별도 컨텍스트) ACCEPT 0 블로커.

## 6. 위험 / 롤백

- 위험 최소(표시 전용·읽기). 롤백 = 헬퍼/배지/라벨 3곳 되돌림.
- 라이브 `pnpm tauri dev` 스모크는 이 브랜치 미부팅(dev-DB skew) — 유닛/critic 검증만(선행 PR과 동일).

## 7. deferred (비차단)

- env(provider) 항목 헬스(divergence는 프로젝트 전용이라 무의미 — 의도적 제외).
- 전체 앱 레벨(사이드바 밖) 헬스 인디케이터.
- 라이브 스모크.

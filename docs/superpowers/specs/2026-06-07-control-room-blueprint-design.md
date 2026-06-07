# Control Room — "Living Blueprint" 리디자인 (프론트 설계)

- 상태: **Accepted (frontend design)** — 구현 플랜은 별도(writing-plans).
- 날짜: 2026-06-07
- 브랜치/워크트리: `feat/control-room-blueprint` @ `work-radar-wt/control-room` (off dev `56ca525`)
- 도메인: `src/components/control-room/**`, `src/lib/controlRoom*.ts` →
  area 규율 `docs/areas/frontend-shell.md` + `DESIGN.md` (Cohere white editorial)
- 범위: **프론트엔드 시각/인터랙션 재설계만.** IPC/bindings/Rust 변경 0.
  풀-DAG 부모 ref를 채우는 백엔드는 §9의 **별도 follow-up PR**로 분리.

---

## 1. 문제

현재 `ControlRoomView.tsx`(215줄)는 **평평한 4-카드 리스트**다 — System Overview(카운트
뱃지) · Agent Session Board(텍스트 4컬럼) · Handoff Queue · Work Lists. 전부 "상태 점 +
줄글"이라:

- 지금 **몇 개의 work이 진행 중인지** 한눈에 안 들어온다.
- 항목 간 **관계/흐름**(어느 세션이 어느 task를 돌리는지)이 안 보인다.
- **무엇이 막혀 있고 / 휴먼 승인 대기인지**가 다른 리스트에 흩어져 시선이 모이지 않는다.

## 2. 핵심 통찰 — 이 데이터는 그래프다

`ControlRoomSnapshot`(거버넌스 하네스 Boule v3의 read-only 투영)은 자연스러운 **층위
(strata)** 와 교차링크를 갖는다:

```
SPEC ─▶ PLAN ─▶ TASK ─▶ SESSION ─▶ HANDOFF
                 │ hasOpenBlock        │ phase=pending  ← 휴먼 승인 대기
                 └ ownership(user/orchestrator/external)
```

**데이터 제약(설계에 직접 영향):** v1 스냅샷에 실제로 존재하는 교차 엣지는
`session.taskId → task` 와 `handoff.sessionId → session` **둘뿐**이다. `spec→plan→task`
부모 참조는 스냅샷에 **없다**(`PlanRow`/`TaskRow`에 부모 id 필드 부재). 따라서:

- v1: spec/plan/task는 **층(band)** 으로 배치하고, 진짜 선은 데이터가 있는 곳에만 긋는다.
- 풀 end-to-end DAG는 **백엔드 follow-up**(§9)에서 `plan.specId`/`task.planId`를 채운 뒤
  프론트 어댑터가 자동으로 엣지를 방출한다 — **SVG 컴포넌트 변경 0**.

## 3. 컨셉 — 레이어드 스키매틱 (블루프린트)

하나의 SVG 캔버스에 **수평 5-레인**(Spec·Plan·Task·Session·Handoff)을 깔고, 노드는
제도(製圖) 느낌의 셀로, 실제 엣지는 직교(orthogonal) 엘보 커넥터로 그린다. 상단엔
"Vitals" 계기바로 한눈 요약. **차단/승인대기/압력 노드는 펄스·강조**로 시선을 강제한다.

```
┌─ CONTROL ROOM ───────────────────── ◷ 2분 전 프로젝션 · ⟳ ─┐
│  VITALS   ▸3 진행중   ▲2 차단   ⏸1 승인대기   ◇5 세션        │
├──────────────────────────────────────────────────────────────┤
│  SPEC      PLAN       TASK           SESSION        HANDOFF   │
│  ┌──┐     ┌──┐       ┌──┐╲          ┌──┐                      │
│  │░░│     │▓▓│       │██│─╲────────▶│◆◆│─ ─ ─ ─▶ ⬡ pending    │
│  └──┘     └──┘       └──┘  ╲        └──┘            (승인 대기) │
│           ┌──┐▲      ┌──┐   ╲──────▶┌──┐ ◐ ctx-pressure       │
│           │▓▓│       │■■│막힘       │◆◆│                      │
│           └──┘       └──┘           └──┘                      │
└──────────────────────────────────────────────────────────────┘
```

## 4. 컴포넌트 아키텍처

```
ControlRoomView.tsx        조립: useControlRoomSnapshot + 헤더 + Vitals + Schematic
├ Vitals.tsx               상단 계기바 (진행중·차단·승인대기·세션) + 클릭 필터-하이라이트
└ Schematic.tsx            SVG 캔버스: hover/select 상태 소유, lineage 하이라이트, 레인 렌더
   ├ SchematicNode.tsx     블루프린트 셀 <g> (라벨·톤·attention 링)
   ├ SchematicEdge.tsx     직교 엘보 커넥터 <path>
   └ NodeTooltip.tsx       hover/click 상세 (id·title·phase·ownership)

lib/controlRoomGraph.ts    순수 로직(신규): 레이아웃·엣지·계보·vitals — DOM 무관
lib/controlRoom.ts         기존 유지: statusTone · bucketSessions · relativeAgo 재사용
```

**경계 원칙(가장 중요):** 레이아웃·엣지 도출·계보(lineage)·vitals 계산은 전부
`controlRoomGraph.ts`의 **순수 함수**로 분리한다. SVG 컴포넌트는 "그리기"만 한다(상태
없는 dumb render + Schematic이 소유한 hover/select prop). → 로직은 node 환경 vitest로
완전 검증되고, 컴포넌트는 시각 검수(사용자/cmux)만 남는다.

## 5. 데이터 모델 (순수 레이어 — `controlRoomGraph.ts`)

입력: `ControlRoomSnapshot`. 출력: 결정적(deterministic) 레이아웃 모델.

```ts
type LaneKind = "spec" | "plan" | "task" | "session" | "handoff";

interface GraphNode {
  id: string;            // `${lane}:${rawId}` 로 충돌 없는 전역 id
  lane: LaneKind;
  label: string;         // title ?? rawId
  rawId: string;
  tone: StatusTone;      // 기존 statusTone()
  attention: boolean;    // blocked task | pending handoff | pressure/handoff_ready session
  ownership?: Ownership; // session 전용
  phase: string;
  x: number; y: number;  // 레이아웃 좌표
}

interface GraphEdge { id: string; source: string; target: string; } // source→target node id

interface Schematic { lanes: LaneKind[]; nodes: GraphNode[]; edges: GraphEdge[]; }
```

**순수 함수 (각각 단위 테스트):**

- `buildSchematic(snap): Schematic` — 노드 생성 + 레이아웃 배치(§6) + 엣지 도출.
- `deriveEdges(snap): GraphEdge[]` — v1: `session.taskId`→task, `handoff.sessionId`→session.
  (백엔드 follow-up 시: `plan.specId`→spec, `task.planId`→plan 자동 추가.) 끊긴 ref
  (대상 노드 없음)는 **엣지 생략**(안전).
- `computeVitals(snap): Vitals` — §7 정의대로 카운트.
- `lineageOf(nodeId, edges): Set<string>` — 양방향 BFS로 연결 노드+엣지 id 집합.
- `attentionOf(...)` — attention 판정(아래 §7과 동일 규칙) 헬퍼.

## 6. 레이아웃 알고리즘 (dagre 불필요 — 고정 레인)

- 5개 레인 = 컬럼. `x = laneIndex × LANE_W`.
- 레인 내부 정렬: **attention 우선**(blocked/pending/pressure를 위로) → 그다음 tone 우선순위
  → 그다음 안정적 tie-break(rawId). `y = rowIndex × ROW_H`.
- 엣지 = 직교 엘보: 소스 우측 앵커 → 중간 x에서 수직 → 타깃 좌측 앵커(겹침 최소화를 위해
  레인 사이 채널 x 사용). 곡선 대신 각진 선 = 제도 느낌.
- 캔버스 크기 = 콘텐츠에 맞춰 산출(폭-우선 핏). 레인이 길어 넘치면 기존
  `.cr-view { overflow-y:auto }` 재사용(세로 스크롤). v1은 자유 pan/zoom 없음.
- 상수(`LANE_W`/`ROW_H`/노드 크기)는 모듈 상수로 두어 테스트가 좌표를 정확히 단언.

## 7. 상태 인코딩 & "막힌 것" 부각

- **톤:** 기존 `statusTone()` 6톤(done/active/waiting/pressure/blocked/muted) →
  기존 `--cr-*` 토큰(`ControlRoomView.css`). 노드 = 톤 보더 + 옅은 틴트 + 라벨. **raw hex
  금지**(토큰만; pressure는 기존 로컬 폴백 유지).
- **Attention 트리트먼트**(시선 강제 — 펄스 링 + lucide 아이콘):
  - task: `hasOpenBlock === true` (orchestrator.tasks 기준).
  - handoff: `phase === "pending"`.
  - session: `phase ∈ {context_pressure_high, checkpoint_requested, handoff_ready}`.
- **Vitals 카운트 정의(확정):**
  - **진행중** = session.phase ∈ {active, opening} 개수.
  - **차단** = (task.hasOpenBlock) + (session.phase === blocked) 합.
  - **승인 대기** = (handoff.phase === pending) + (session.phase ∈
    {checkpoint_requested, handoff_ready}) 합.
  - **세션** = sessions 총수.

## 8. 인터랙션 (읽기전용 + 계보) — Schematic 로컬 상태

- **hover** 노드 → `lineageOf`로 연결 노드/엣지 발광, 나머지 dim. = "이 work의 계보".
- **click** 노드 → 선택 고정(sticky highlight) + `NodeTooltip`(id·title·phase·ownership).
  빈 캔버스 클릭 또는 **Esc** → 해제.
- **Vitals 항목 클릭** → 해당 부류(예: 차단) 노드만 강조하는 필터-하이라이트(토글).
- **mutation 없음** — read-only 거버넌스 스냅샷 존중. 승인/거절 액션은 외부-액션 게이트
  (HITL)와 백엔드를 요해 **명시적으로 범위 밖**(향후 별도 트랙).
- Esc는 로컬 상태 해제만 — overlay가 아니므로 overlay-stack 등록 불요.

## 9. 풀-DAG 백엔드 Follow-up (별도 PR — 이 스펙 범위 밖)

프론트는 계보-완성형을 소비하도록 이미 설계됨. 백엔드 PR에서:

- `PlanRow`에 `specId: string | null`, `TaskRow`에 `planId: string | null` 추가
  (거버넌스 투영 소스에서 파생; specta i64 금지 규율 준수, 마이그레이션은 해당 시).
- `deriveEdges`가 새 ref로 spec→plan·plan→task 엣지 자동 방출 → **SVG/레이아웃 변경 0**.
- bindings 재생성(`cargo test`)으로 drift 게이트 통과.

## 10. 모션 (라이브러리 활용)

`motion`(framer-motion)으로: 노드 stagger-enter · 엣지 pathLength draw-in · attention 펄스
· hover 하이라이트/dim 전환. `prefers-reduced-motion` 폴백 필수. 사용은 몇 컴포넌트로
**격리**해 필요 시 CSS-only로 교체 가능하게 둔다(유일한 신규 의존성).

## 11. 미감 (DESIGN.md — Cohere white editorial)

화이트 캔버스 · hairline 스트로크(`border-border`) · id는 `tabular-nums`/모노 악센트 · 직교
커넥터 + 얇은 베이스라인 그리드로 **blueprint 느낌**(다크 사이버펑크 아님) · 레인 헤더는
uppercase tracking-wide(기존 CSS 패턴 재사용). 신규 색은 도입하지 않고 기존 `--cr-*`
토큰만 사용.

## 12. 검증

- **순수함수 vitest**(기존 `controlRoom.test.ts` 패턴, node 환경 유지 — RTL 미도입):
  `buildSchematic`(레인/좌표/정렬) · `deriveEdges`(실엣지만·끊긴 ref 생략) ·
  `computeVitals`(§7 카운트) · `lineageOf`(양방향 BFS) · `attentionOf`.
- **컴포넌트 = dumb render**라 DOM 테스트 불요(환경/RTL 추가 = scope creep, 회피).
- **시각/인터랙션 라이브 검수 = 사용자/cmux**(네이티브 WKWebView, 에이전트 불가).
- 게이트: `pnpm typecheck` · `pnpm lint` · `pnpm vitest run` · bindings drift 0.

## 13. 파일 변경 요약

- **수정:** `ControlRoomView.tsx`(조립 교체) · `ControlRoomView.css`(스키매틱 토큰/클래스 확장).
- **신규:** `lib/controlRoomGraph.ts`(+`.test.ts`) ·
  `components/control-room/{Vitals,Schematic,SchematicNode,SchematicEdge,NodeTooltip}.tsx`.
- **유지:** `lib/controlRoom.ts`(`statusTone`/`bucketSessions`/`relativeAgo` 재사용) ·
  `lib/query/governance.ts`(`useControlRoomSnapshot` 그대로).
- **신규 의존성:** `motion`(§10) 1건. **bindings/Rust 변경 0**(풀-DAG=§9 별도 PR).

## 14. 비범위 (YAGNI)

- 자유 pan/zoom·드래그·노드 편집(React Flow류) — 고정 레인이라 불요.
- 승인/거절 등 mutation — 외부-액션 게이트 트랙.
- spec→plan→task 풀 엣지 데이터 — §9 백엔드 follow-up.
- 무관 리팩터·다른 View 변경.

# Work Radar — Design Direction (Raycast) — ARCHIVED

> **상태: 보존(archived).** 2026-05-21 work-radar 디자인이 Cohere 스타일(white editorial)로
> 피봇되면서 이 Raycast 방향은 정본에서 제외됨. 현재 정본은 루트 `DESIGN.md`.
> 이 문서는 과거 의사결정 추적용으로만 보존한다.

## 원칙

Raycast의 본질은 **command-palette-first, 키보드 구동, 로컬처럼 즉각, 최소 chrome**.
Work Radar는 이걸 그대로 따른다.

1. **캡처 마찰 0.** 전역 핫키 → braindump 한 줄 → 사라짐. 어디서든. (킬러 기능)
2. **키보드 우선.** 분류 `1/2/3/4`, 액션은 `Cmd+K` 팔레트(cmdk). 드래그앤드롭은 보조(마우스).
3. **즉각성.** 모든 읽기는 로컬 SQLite. 네트워크(Notion/GitHub)는 백그라운드 + optimistic.
4. **최소 chrome.** 영구 7탭 대시보드 금지. 하나의 팔레트 + 커맨드로 도달하는 소수 뷰.

## 인터랙션 모델

- **루트:** 검색창(FTS5) + 컨텍스트 액션 패널. Raycast의 root search와 동일.
- **캡처:** 전역 핫키(예: `⌥Space`)로 떠서 한 줄 입력 후 Enter → unclassified로 저장.
- **매트릭스:** 2×2는 _보기_ 모드. 카드 포커스 후 `1/2/3/4`로 사분면 이동.
- **액션:** 카드에서 `Cmd+K` → promote / snooze / done / archive / link / "Codex로 도와줘".
- **승격:** Notion 백로그/안건/Today/일정. 항상 사람이 확정(자동 승격 없음).

## 비주얼 톤

- 다크 기본, 고밀도, 빠른 모션(150–200ms), 최소 보더.
- shadcn/ui 프리미티브 + Tailwind. 팔레트는 `cmdk`.
- 모노스페이스 악센트(키 힌트, 티켓 키, PR 번호).
- 사분면 색: Q1 경고/적, Q2 차분/청, Q3 중립, Q4 흐림. 단 색만으로 의미 전달 금지(라벨 병기).

## 뷰 (커맨드로 도달)

- **Matrix** — 결정의 중심. 2×2 + 카드.
- **PR Radar** — repo별 readiness 버킷. 매트릭스로는 임계치만 escalate.
- **Worktrees / Diff** — repo별 worktree·브랜치 목록(ahead/behind/dirty 배지) + 파일별 diff. 비교 모드 working/staged/vs_base/branch↔branch. read-only.
- **Backlog** — Notion 미러 상태(stale/PR linked/done candidate).
- **Today** — 일정 + Q1 + focus + PR attention + 미분류 수.
- **Jobs** — AgentRun(Codex/Hermes) 진행/비용/로그 + kill.
- **Timeline / Review** — 주간 흐름, Work Debt.

## 안티패턴

- 모든 신호를 매트릭스에 거울처럼 쏟기 (= 새 inbox 과부하).
- 네트워크가 UI를 블록하기.
- enrich 결과로 카드를 자동 분류하는 one-click 승격 버튼.
- 영구 탭바로 무거운 대시보드 만들기.

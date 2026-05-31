# Boule — SSOT Governance Harness (P1 skeleton)

work-radar 레포 안의 self-contained 사이드카(Tauri/Vite 빌드 그래프 밖). markdown이
SSOT(`workspace/`), 인덱스(Postgres)는 P3에서 도입. P1은 순수 markdown + Node 서비스.

상위 설계 정본: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md`.

## 구조

- `workspace/` — git-tracked SSOT (events/patterns/hypotheses/reviews/state/agents/interfaces)
- `src/event/` — SSOT 직렬화 (id, frontmatter, append-only write)
- `src/gateway/` — 레포 활동 → 정규화 L0 event
- `src/mcp/` — Governance MCP 인터페이스 (handlers + stdio server)

## 개발

```bash
pnpm --dir governance install
pnpm --dir governance test
```

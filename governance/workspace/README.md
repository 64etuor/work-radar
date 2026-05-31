# Boule SSOT Workspace

markdown이 단일 진실의 원천(SSOT). 인덱스(Postgres, P3+)는 파생물이며 이 디렉토리에서
완전 재구축 가능하다(§3.2 write-first rule).

- `events/`     L0 — append-only, immutable. `YYYY-MM-DD/HH-MM-SS_<type>.md`
- `patterns/`   L1 — 반복 관찰 (active/ archived/)
- `hypotheses/` L2 — 검증 가능 가설 (testing/ archived/)
- `reviews/`    External Reviewer 산출물 (P2+)
- `state/`      재생성 가능 캐시 view
- `agents/`     에이전트 명세서 (SSOT의 일부)
- `interfaces/` MCP 명령/도구 명세

L3 Decisions / L4 Principles는 여기 복제하지 않는다 — 정본은
`docs/adr/` + `docs/decisions.md` + `docs/areas/decision-rails.md`. 어댑터(P2/P3)가 인덱싱.

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

## Hermes 로드 경로 (spec §5.0)

Governance MCP 서버(`src/mcp/server.ts`)를 Hermes 세션에 노출하는 두 경로:

### A안 — work-radar 자동 주입 (기본)

work-radar가 ACP `session/new`의 `mcpServers` 배열에 stdio 디스크립터를 **opt-in 주입**한다.
사용자 config 무변경, 내부 ACP 페이로드(`bindings.ts`/specta 무관).

```bash
# work-radar 기동 시 환경변수로 opt-in
BOULE_GOVERNANCE_DIR=<repo>/governance pnpm tauri dev
# (선택) GUI/Finder 기동으로 PATH에 node가 없을 때 절대경로 override
BOULE_NODE=/opt/homebrew/bin/node BOULE_GOVERNANCE_DIR=<repo>/governance pnpm tauri dev
```

- `BOULE_GOVERNANCE_DIR` 미설정/빈값 → 주입 없음(오늘과 동일, 무부작용).
- 설정됐으나 `<dir>/src/mcp/server.ts` 부재 → 경고 로그(경로만) 후 주입 생략(graceful degrade).
- **알려진 제약:** node 바이너리는 기본 PATH 의존(`"node"`). 터미널 기동(`pnpm tauri dev`)은
  PATH에 node가 있어 OK. Finder/GUI 기동은 `BOULE_NODE`(절대경로)로 보완.

주입되는 디스크립터(ACP `McpServerStdio`, `env`는 **리스트** 형):

```jsonc
{
  "name": "boule-governance",
  "command": "node", // 또는 BOULE_NODE
  "args": ["--experimental-strip-types", "<dir>/src/mcp/server.ts"],
  "env": [{ "name": "BOULE_WORKSPACE", "value": "<dir>/workspace" }]
}
```

> **구현 노트 (no-build):** Node 24의 `--experimental-strip-types`는 `.js`
> import 지정자를 `.ts`로 재매핑하지 않는다 → 런타임 src 그래프(`src/**`)는 `.ts`
> 확장자 import를 쓰고 `tsconfig`에 `allowImportingTsExtensions`를 켠다. **테스트
> 파일은 `.js` import 유지** — vitest(Vite 리졸버)는 `.js`→`.ts`를 투명 매핑하므로
> Node strip-types의 literal 해석에 묶일 필요가 없다(tsc/vitest 양쪽 green).

### B안 — 독립 hermes / cron (`~/.hermes/config.yaml`)

work-radar 없이 hermes를 직접/스케줄로 돌릴 때. ACP와 달리 config.yaml의 `env`는 **딕셔너리** 형:

```yaml
mcp_servers:
  boule-governance:
    transport: stdio
    command: node
    args:
      - --experimental-strip-types
      - <repo>/governance/src/mcp/server.ts
    env:
      BOULE_WORKSPACE: <repo>/governance/workspace
    tools:
      include: [create_task, status, observations]
```

> ⚠️ hermes는 config 변경 시 `mcp_reload_confirm` 게이트로 재로드 승인을 요구할 수 있다.

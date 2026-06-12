# Boule — SSOT Governance Harness

work-radar 레포 안의 self-contained 사이드카(Tauri/Vite 빌드 그래프 밖). markdown 이벤트가
SSOT, 인덱스는 PGlite(v3 Phase F; pgvector deferred). **라이브 런타임 스토어는 per-repo
`<repo>/.boule/workspace`**(ADR-0009 per-repo 전환) — 이 디렉터리의 `workspace/`가 아니다.

설계/계획 전체 인덱스: **`docs/INDEX.md`** (단일 진입점). 진행 상태·실행 큐 = `docs/STATUS.md`.
최신 마스터 설계 = `docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
(v3 Orchestrator Control Plane). 운영 규율 = `docs/harness/HARNESS.md`.

## 구조

- `docs/` — 이 하네스의 설계/계획 문서 (`design/` spec · `plans/` plan · `INDEX.md` 카탈로그 · `STATUS.md` 진행 ledger · `harness/` 운영 규율+에이전트/MCP 명세)
- `workspace/` — **LEGACY (2026-06-02 동결)**: 초기 글로벌 SSOT였으나 per-repo `.boule/workspace`로
  이전됨. 순수 동결 이벤트 아카이브만 잔존(durable 문서는 `docs/harness/`로 이동 완료 —
  2026-06-12 P5a). 새 이벤트를 여기 쓰지 않는다.
- `src/event/` — SSOT 직렬화 (id, frontmatter, append-only write)
- `src/gateway/` — 레포 활동 → 정규화 L0 event
- `src/mcp/` — Governance MCP 인터페이스 (handlers + stdio server)

## 개발

```bash
pnpm --dir governance install
pnpm --dir governance test
```

CLI는 `governance/bin/boule`로 바로 실행한다 (`./bin/boule status --repo <p>` —
`node --experimental-strip-types …` 주문 불필요; `boule schedule install --repo <abs>`가
launchd 틱 스케줄을 설치한다. 사용자 발동·가역·`<repo>/.boule/schedule-audit.log` 감사).

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
      BOULE_WORKSPACE: <repo>/.boule/workspace # 라이브 per-repo 스토어 (구 governance/workspace 아님)
    tools:
      include: [create_task, status, observations]
```

> ⚠️ hermes는 config 변경 시 `mcp_reload_confirm` 게이트로 재로드 승인을 요구할 수 있다.

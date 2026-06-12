import type {
  Skill,
  SkillDivergence,
  SkillEnvironment,
  SkillProvider,
  SkillWorkspace,
} from "@/bindings";

/**
 * 스킬 레지스트리 좌측 **환경 사이드바**의 순수 로직 (P1, #2/#14). SkillsView가 소비한다.
 *
 * "환경"은 외부 스킬을 발견한 제공 도구(provider)다. 사이드바는 "전체" + "인앱 프롬프트" +
 * **감지된(또는 스킬이 있는) 외부 provider만** 노출한다 — 설치 안 된 환경은 숨긴다(`detect_skill_environments`의
 * present 또는 목록에 실제 스킬 존재). provider 귀속은 백엔드 `Skill.provider`(P0)를 그대로 쓴다 —
 * 프런트 경로추론(구 `providerOf`) 폐기.
 *
 * 순수 함수(부수효과 없음) — vitest 단위테스트 대상. 드래그 재정렬은 id 순서 배열(localStorage)만
 * 다루고 외부 상태는 바꾸지 않는다(#14 로컬 표시 순서).
 */

/** 외부 provider 표시 라벨. */
export const SKILL_PROVIDER_LABEL: Record<SkillProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  other: "기타",
};

/** 외부 provider 기본 노출 순서(감지된 것만 렌더). */
export const SKILL_PROVIDER_ORDER: SkillProvider[] = [
  "claude",
  "codex",
  "openclaw",
  "hermes",
  "other",
];

/** URL 설치 대상 provider 옵션(라벨 포함). */
export interface InstallProviderOption {
  provider: SkillProvider;
  label: string;
}

/**
 * URL 설치 대상 provider 드롭다운 옵션(D5a, presence-gate). `detect_skill_environments`가
 * present=true로 보고한 에이전트 provider만 노출한다 — 설치 안 된 에이전트(예: OpenClaw 부재)는 숨긴다.
 * `"other"`는 특정 에이전트 dir이 아닌 catch-all이라 항상 포함한다(라이브러리 전용 설치 대상).
 *
 * 순수 함수(부수효과 없음) — vitest 단위테스트 대상. 표시 순서는 `SKILL_PROVIDER_ORDER`를 따른다.
 */
export function buildInstallProviderOptions(
  environments: SkillEnvironment[] | undefined,
): InstallProviderOption[] {
  const present = new Set<SkillProvider>();
  for (const e of environments ?? []) {
    if (e.present) present.add(e.provider);
  }

  const options: InstallProviderOption[] = [];
  for (const provider of SKILL_PROVIDER_ORDER) {
    if (provider !== "other" && !present.has(provider)) continue;
    options.push({ provider, label: SKILL_PROVIDER_LABEL[provider] });
  }
  return options;
}

export type SkillEnvNavId = "all" | "in_app" | `provider:${SkillProvider}` | `workspace:${string}`;

export interface SkillEnvNavItem {
  id: SkillEnvNavId;
  label: string;
  /** 이 환경에 속하는 스킬 판별(필터·카운트 공용). All=항상, in_app=인앱, provider=해당 외부 provider. */
  match: (s: Skill) => boolean;
  /** true면 드래그 재정렬에서 제외(고정). "전체"만 고정. */
  pinned: boolean;
  /** 워크스페이스 항목의 repos.id(#17 헬스 lookup 키). env/provider 항목은 없음 — id에서 역추론하지
   *  않도록 빌더가 직접 부여(C6: 키 단일 출처). */
  repoId?: string;
}

/**
 * 사이드바 환경 항목 빌드: "전체" + "인앱 프롬프트"(항상) + 감지됐거나 스킬이 있는 외부 provider만.
 * `environments`(detect 결과)는 **설치만 됐고 스킬 0개**인 환경도 present=true면 노출하게 해준다.
 */
export function buildSkillEnvNav(
  skills: Skill[],
  environments: SkillEnvironment[] | undefined,
): SkillEnvNavItem[] {
  const items: SkillEnvNavItem[] = [
    { id: "all", label: "전체", match: () => true, pinned: true },
    {
      id: "in_app",
      label: "인앱 프롬프트",
      match: (s) => s.kind === "in_app_prompt",
      pinned: false,
    },
  ];

  // 감지된(present) provider ∪ 목록에 실제 스킬이 있는 provider — detect 실패해도 graceful.
  const present = new Set<SkillProvider>();
  for (const e of environments ?? []) if (e.present) present.add(e.provider);
  for (const s of skills) if (s.kind === "external" && s.provider) present.add(s.provider);

  for (const p of SKILL_PROVIDER_ORDER) {
    if (!present.has(p)) continue;
    items.push({
      id: `provider:${p}`,
      label: SKILL_PROVIDER_LABEL[p],
      match: (s) => s.provider === p,
      pinned: false,
    });
  }
  return items;
}

/**
 * 프로젝트 워크스페이스 사이드바 항목(G3-PR1, #16). 백엔드 `list_skill_workspaces`가 준 멤버십
 * (`memberPaths`)을 Set으로 lookup해 필터한다 — **프런트 경로추론 없음**(scan.rs가 단일 출처). 환경
 * provider 항목과 달리 별도 "프로젝트" 섹션에 렌더되며 드래그 재정렬 대상이 아니다(`pinned: true`).
 */
export function buildSkillWorkspaceNav(
  workspaces: SkillWorkspace[] | undefined,
): SkillEnvNavItem[] {
  return (workspaces ?? []).map((w) => {
    const members = new Set(w.memberPaths);
    return {
      id: `workspace:${w.repoId}` as SkillEnvNavId,
      label: w.label,
      match: (s: Skill) => s.sourcePath != null && members.has(s.sourcePath),
      pinned: true,
      repoId: w.repoId,
    };
  });
}

/**
 * 저장된 순서(id 배열)대로 정렬한다. 고정 항목("전체")은 언제나 선두 유지. 저장 순서에 없는 id는
 * 기본 순서를 보존한 채 뒤로(안정 정렬). 외부 상태 불변 — 표시 순서만.
 */
export function applyEnvOrder(items: SkillEnvNavItem[], order: string[]): SkillEnvNavItem[] {
  const pinned: SkillEnvNavItem[] = [];
  const movable: SkillEnvNavItem[] = [];
  for (const item of items) {
    if (item.pinned) pinned.push(item);
    else movable.push(item);
  }

  const ranks = new Map<string, number>();
  order.forEach((id, idx) => ranks.set(id, idx));
  const rank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
  // Array.sort는 안정적 → 동일 rank(둘 다 미저장)면 원래 순서 유지.
  const sorted = [...movable].sort((a, b) => rank(a.id) - rank(b.id));
  return [...pinned, ...sorted];
}

/** 한 환경의 enabled/total 카운트(주어진 스킬 집합에 match 적용). 사이드바 배지 + 빈 환경 표시용. */
export function envCounts(
  item: SkillEnvNavItem,
  skills: Skill[],
): { enabled: number; total: number } {
  let enabled = 0;
  let total = 0;
  for (const skill of skills) {
    if (!item.match(skill)) continue;
    total += 1;
    if (skill.enabled) enabled += 1;
  }
  return { enabled, total };
}

/**
 * 드래그 재정렬 결과(id 순서) 계산 — 순수. `dragId`를 `targetId` 위치로 이동한 새 movable id 순서를
 * 돌려준다. 이동 불가(미발견/동일)면 현재 순서 그대로. 고정 항목은 대상이 아니다.
 */
export function reorderEnv(movableIds: string[], dragId: string, targetId: string): string[] {
  if (dragId === targetId) return movableIds;
  const from = movableIds.indexOf(dragId);
  const to = movableIds.indexOf(targetId);
  if (from === -1 || to === -1) return movableIds;
  const next = [...movableIds];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}

/**
 * Diverged 멤버 스킬의 `memberPath` Set. 카드 렌더가 `skill.sourcePath` 로 O(1) lookup 한다 —
 * 프런트 경로추론 없음(C6, divergence.rs가 경로/매칭의 단일 출처). `in_sync`/미수록은 마커 없음.
 */
export function buildDivergedPathSet(divergences: SkillDivergence[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const d of divergences ?? []) {
    if (d.status === "diverged") out.add(d.memberPath);
  }
  return out;
}

/**
 * Diverged 멤버의 `memberPath` → 프로젝트 라벨 맵(G3 fast-follow #6 — per-location divergence 귀속).
 * 카드 마커가 바이너리 "·다름" 대신 **어느 프로젝트가 diverged인지** 표기하는 데 쓴다. status는 백엔드
 * `divergence.rs`가 단일 출처(C6) — FE는 `repoId`로 `workspaces` 라벨을 조인할 뿐(경로추론 없음). 라벨
 * 미발견(이론상 없음 — 모든 Local repo가 워크스페이스)은 `repoId` 폴백. `in_sync`/미수록은 맵에 없음.
 * undefined → 빈 맵.
 */
export function buildDivergedLocationLabels(
  divergences: SkillDivergence[] | undefined,
  workspaces: SkillWorkspace[] | undefined,
): Map<string, string> {
  const labelByRepo = new Map<string, string>();
  for (const w of workspaces ?? []) labelByRepo.set(w.repoId, w.label);
  const out = new Map<string, string>();
  for (const d of divergences ?? []) {
    if (d.status !== "diverged") continue;
    out.set(d.memberPath, labelByRepo.get(d.repoId) ?? d.repoId);
  }
  return out;
}

/**
 * repoId → diverged 멤버 수(G3-PR3, #17 — 표시 전용 sync 헬스 rollup). divergences가 상태 단일
 * 출처(C6 — `status`는 divergence.rs 판정, FE는 그룹·카운트만·경로추론 없음). `in_sync`/미수록은
 * 카운트하지 않는다(정상=무배지). `buildDivergedPathSet`의 카운트 트윈. 전체 합계는 호출부에서
 * `[...health.values()].reduce(...)`.
 */
export function buildWorkspaceHealth(
  divergences: SkillDivergence[] | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of divergences ?? []) {
    if (d.status === "diverged") out.set(d.repoId, (out.get(d.repoId) ?? 0) + 1);
  }
  return out;
}

/** vendoring 대상 provider(프로젝트 dir 관례 있는 것 — 백엔드 scan::vendor_subdir의 FE 트윈). 백엔드가
 *  authoritative이며 그 외 provider는 unsupported_provider로 거부한다. */
export const VENDORABLE_PROVIDERS: ReadonlySet<SkillProvider> = new Set<SkillProvider>([
  "claude",
  "codex",
]);

export type VendorState = "absent" | "in_sync" | "diverged";
export interface VendorTarget {
  repoId: string;
  label: string;
  state: VendorState;
}

/**
 * managed 스킬 (provider,name)에 대해 vendorable 프로젝트(워크스페이스)별 vendor 상태를 도출(G3-PR2b).
 * 상태의 단일 출처는 divergences(repoId+provider+name → status) — 프런트 경로추론 없음(C6). divergence
 * 목록에 없는 워크스페이스 = absent. managed가 아니거나 provider가 vendorable이 아니면 빈 배열(패널 숨김).
 */
export function buildVendorTargets(
  skill: Skill,
  workspaces: SkillWorkspace[] | undefined,
  divergences: SkillDivergence[] | undefined,
): VendorTarget[] {
  if (skill.kind !== "managed" || !skill.provider || !VENDORABLE_PROVIDERS.has(skill.provider)) {
    return [];
  }
  const { provider, name } = skill;
  const stateByRepo = new Map<string, VendorState>();
  for (const d of divergences ?? []) {
    if (d.provider === provider && d.name === name) {
      stateByRepo.set(d.repoId, d.status === "diverged" ? "diverged" : "in_sync");
    }
  }
  return (workspaces ?? []).map((w) => ({
    repoId: w.repoId,
    label: w.label,
    state: stateByRepo.get(w.repoId) ?? "absent",
  }));
}

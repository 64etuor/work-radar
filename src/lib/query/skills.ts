import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateSkillInput,
  type Skill,
  type SkillEnvironment,
  type SkillProvider,
  type UserSkillRoot,
} from "@/bindings";

import { unwrap } from "./client";

// 스킬 공유 레지스트리 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
// Claude/Codex 스킬(~/.claude/skills)을 한 곳에서 본다. 프롬프트 편집은 codex 제안 *내용*만
// 바꾼다 — 잡은 여전히 제안 레일 + Acceptance 게이트(#1/#2). 외부 스킬은 디스크 SSOT(읽기/편집).

/** 레지스트리 목록(인앱 + 외부 합쳐). 외부는 매 호출 스캔(디스크 SSOT). */
export function useSkills() {
  return useQuery<Skill[]>({
    queryKey: ["skills"],
    queryFn: () => unwrap(commands.listSkills()),
    staleTime: 10_000,
  });
}

/** 감지된 스킬 환경(provider별 present/count/root). 좌측 env 사이드바가 "설치된 환경만" 렌더하는 데 쓴다. */
export function useSkillEnvironments() {
  return useQuery<SkillEnvironment[]>({
    queryKey: ["skillEnvironments"],
    queryFn: () => unwrap(commands.detectSkillEnvironments()),
    staleTime: 10_000,
  });
}

/** 인앱 프롬프트 수정(prompt/name/enabled 부분 업데이트). 외부 스킬은 거부(파일을 직접 편집). */
export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      prompt?: string | null;
      name?: string | null;
      enabled?: boolean | null;
    }) =>
      unwrap(
        commands.updateSkill(args.id, args.prompt ?? null, args.name ?? null, args.enabled ?? null),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** 인앱 프롬프트 추가(미바인딩 또는 닫힌 binding). */
export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => unwrap(commands.createSkill(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** 인앱 프롬프트 삭제(외부는 거부). 시드 binding 삭제 시 잡은 코드 상수로 폴백. */
export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteSkill(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** 외부 스킬 파일 내용 읽기(SKILL.md만, ~/.claude/skills 하위 가드). 경로 없으면 비활성. */
export function useExternalSkillContent(path: string | null) {
  return useQuery<string>({
    queryKey: ["externalSkillContent", path],
    queryFn: () => unwrap(commands.readExternalSkill(path as string)),
    enabled: !!path,
    staleTime: 5_000,
  });
}

/** 사용자 설정 임의 스킬 루트(P1.5 #3 — 위치-축 안전망). 미설정 시 빈 배열. */
export function useSkillUserRoots() {
  return useQuery<UserSkillRoot[]>({
    queryKey: ["skillUserRoots"],
    queryFn: () => unwrap(commands.getSkillUserRoots()),
    staleTime: 10_000,
  });
}

/**
 * 사용자 설정 임의 스킬 루트 저장. 각 경로는 절대경로여야 한다(상대 경로는 AppError로 거부).
 * 성공 시 사용자 루트 + 스킬 목록/환경을 무효화(새 루트가 스캔에 즉시 반영되도록).
 */
export function useSetSkillUserRoots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roots: UserSkillRoot[]) => unwrap(commands.setSkillUserRoots(roots)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skillUserRoots"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skillEnvironments"] });
    },
  });
}

/**
 * 스킬 태그 통째 교체(set 의미 — Phase 3 #12). skillKey = 통합 Skill.id(인앱=행 id, 외부='ext:'+경로).
 * 인앱/외부 모두 태깅 가능하며 **외부는 로컬 SQLite만 바뀐다(디스크 파일 무변경)**. 사람 태깅 전용(#1).
 * 성공 시 목록 무효화(태그/필터 즉시 반영).
 */
export function useSetSkillTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { skillKey: string; tags: string[] }) =>
      unwrap(commands.setSkillTags(args.skillKey, args.tags)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/**
 * 발견된 외부 스킬을 work-radar 중앙 라이브러리로 import(ADR-0006 레일 ①② — 가역·감사). 외부 파일은
 * 읽기만 하고 중앙으로 복사한다(원본 무손상). 잡을 spawn하지 않는다(#1/#2 — 단순 파일 복사). 성공 시
 * 목록 무효화 → managed가 같은 (name, provider)의 발견본을 억제(중앙 복사본이 대체).
 */
export function useImportExternalSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; provider: SkillProvider }) =>
      unwrap(commands.importExternalSkill(args.path, args.provider)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/**
 * 중앙 라이브러리에서 managed 스킬 제거(가역의 반대편 — 중앙 복사본만 삭제, 외부 원본은 건드리지
 * 않는다). 모든 쓰기는 감사(레일 ①). 성공 시 목록 무효화 → 억제 해제되어 발견 외부본이 다시 보인다.
 */
export function useRemoveManagedSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { provider: SkillProvider; name: string }) =>
      unwrap(commands.removeManagedSkill(args.provider, args.name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/**
 * GitHub repo URL에서 스킬을 work-radar 중앙 라이브러리로 설치(ADR-0006 레일 ③ — bounded·감사).
 * 네트워크 fetch/토큰은 전부 Rust에 있다(렌더러 토큰 비노출). 이번 라운드는 공개 repo 우선.
 * 잡을 spawn하지 않는다(#1/#2 — tarball 받아 파일 복사). 성공 시 목록 무효화 → managed로 노출.
 */
export function useInstallSkillFromGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { url: string; provider: SkillProvider }) =>
      unwrap(commands.installSkillFromGit(args.url, args.provider)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/**
 * 중앙 라이브러리 백업 스냅샷 목록(최신 먼저). 백업/복원 패널이 연다.
 */
export function useSkillBackups() {
  return useQuery({
    queryKey: ["skillBackups"],
    queryFn: () => unwrap(commands.listSkillBackups()),
    staleTime: 5_000,
  });
}

/**
 * 중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업(ADR-0006 가역성 레일 — 파일 복사 + 감사, 잡 비취급).
 * 성공 시 백업 목록 무효화.
 */
export function useBackupSkillLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.backupSkillLibrary()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skillBackups"] }),
  });
}

/**
 * 선택한 스냅샷으로 중앙 라이브러리 복원. **복원 직전 상태가 사전 안전 스냅샷으로 보존**되어 복원
 * 자체도 가역이다. provenance 고아 행은 정리된다. 성공 시 스킬 목록 + 백업 목록 무효화.
 */
export function useRestoreSkillLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.restoreSkillLibrary(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skillBackups"] });
    },
  });
}

/** 추적 managed 스킬의 업데이트 상태(provenance — 네트워크 비취급). 뱃지/토글/적용 UI가 쓴다. */
export function useSkillUpdateStatus() {
  return useQuery({
    queryKey: ["skillUpdateStatus"],
    queryFn: () => unwrap(commands.listSkillUpdateStatus()),
    staleTime: 5_000,
  });
}

/** per-skill auto-update opt-in 토글. 성공 시 상태 무효화. */
export function useSetSkillAutoUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { provider: SkillProvider; name: string; enabled: boolean }) =>
      unwrap(commands.setSkillAutoUpdate(args.provider, args.name, args.enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skillUpdateStatus"] }),
  });
}

/**
 * 추적 스킬 전체 업스트림 확인(한 패스, bounded). 네트워크 fetch는 전부 Rust(렌더러 토큰 비노출).
 * 새 버전은 staging만 — 자동 적용/실행 없음(#1/#2). 성공 시 상태 무효화.
 */
export function useCheckSkillUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.checkSkillUpdates()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skillUpdateStatus"] }),
  });
}

/**
 * staged 업데이트 적용(사전 전체 백업 후 교체 — 가역). 잡 spawn 없음(#1/#2 — 파일 복사 + DB).
 * 성공 시 스킬 목록 + 업데이트 상태 + 백업 목록 무효화.
 */
export function useApplySkillUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { provider: SkillProvider; name: string }) =>
      unwrap(commands.applySkillUpdate(args.provider, args.name)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skillUpdateStatus"] });
      qc.invalidateQueries({ queryKey: ["skillBackups"] });
    },
  });
}

/** on-launch 자동 확인 글로벌 setting(opt-in, 기본 꺼짐). 한 bounded 패스만 — 자동 적용 없음. */
export function useSkillUpdateOnLaunch() {
  return useQuery({
    queryKey: ["skillUpdateOnLaunch"],
    queryFn: () => unwrap(commands.getSkillUpdateOnLaunch()),
    staleTime: 30_000,
  });
}
export function useSetSkillUpdateOnLaunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => unwrap(commands.setSkillUpdateOnLaunch(enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skillUpdateOnLaunch"] }),
  });
}

/** 외부 스킬 파일 쓰기(사용자 명시 편집 — 자기 파일). 성공 시 내용/목록 무효화. */
export function useWriteExternalSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; content: string }) =>
      unwrap(commands.writeExternalSkill(args.path, args.content)),
    onSuccess: (_d, args) => {
      qc.invalidateQueries({ queryKey: ["externalSkillContent", args.path] });
      qc.invalidateQueries({ queryKey: ["externalSkills"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

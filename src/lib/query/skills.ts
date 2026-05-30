import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateSkillInput,
  type Skill,
  type SkillEnvironment,
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

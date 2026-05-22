import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands } from "@/bindings";
import { defaultKeymap } from "@/lib/nav";

/**
 * 네비게이션 설정 훅 (Phase 18 #7). 글로벌 창 핫키 + per-view keymap을 app_config(SQLite)에서
 * 읽고 쓴다. keymap은 JSON 문자열로 영속되며, 미설정 시 코드 상수 기본 keymap을 쓴다.
 */

/** 현재 글로벌 창 핫키 문자열(미설정 시 기본 Ctrl+Space를 Rust가 돌려준다). */
export function useGlobalHotkey() {
  return useQuery<string>({
    queryKey: ["globalHotkey"],
    queryFn: () => unwrap(commands.getGlobalHotkey()),
    staleTime: 60_000,
  });
}

/** 글로벌 창 핫키 변경(런타임 재등록 + 영속). 충돌/무효 시 Err — 옛 핫키 유지. */
export function useSetGlobalHotkey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: string) => unwrap(commands.setGlobalHotkey(spec)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["globalHotkey"] }),
  });
}

/** 글로벌 창 핫키를 기본값(Ctrl+Space)으로 리셋 + 재등록. */
export function useResetGlobalHotkey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.resetGlobalHotkey()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["globalHotkey"] }),
  });
}

/**
 * per-view keymap(view→shortcut). 저장된 JSON을 파싱하고 누락 view는 기본값으로 채운다.
 * 저장 행이 없으면 전부 기본값.
 */
export function useNavKeymap() {
  return useQuery<Record<string, string>>({
    queryKey: ["navKeymap"],
    queryFn: async () => {
      const raw = await unwrap(commands.getNavKeymap());
      const base = defaultKeymap();
      if (!raw) return base;
      try {
        const saved = JSON.parse(raw) as Record<string, string>;
        // 저장값이 기준 — 사용자가 비운 항목도 존중(빈 문자열 = 단축키 없음).
        return { ...base, ...saved };
      } catch {
        return base;
      }
    },
    staleTime: 60_000,
  });
}

/** keymap 저장(JSON 문자열). 빈 문자열 단축키 = 그 view 단축키 비활성. */
export function useSetNavKeymap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keymap: Record<string, string>) =>
      unwrap(commands.setNavKeymap(JSON.stringify(keymap))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["navKeymap"] }),
  });
}

/** keymap을 기본값으로 리셋(저장 행 삭제). */
export function useResetNavKeymap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.resetNavKeymap()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["navKeymap"] }),
  });
}

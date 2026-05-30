import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetSkillUserRoots, useSkillUserRoots } from "@/lib/query";

import { SectionLabel } from "./SettingsKit";

/**
 * 사용자 설정 임의 스킬 루트 (P1.5 #3 — 위치-축 안전망).
 * 우리가 하드코딩하지 않은 스킬 디렉터리를 사용자가 직접 등록한다. 경로는 절대경로여야 하며
 * (상대 경로는 Rust가 AppError로 거부), 등록된 루트는 같은 집계(`skill_roots_db`)로 흘러
 * 스캔·path-guard에 자동 포함된다. 외부 dir에 쓰지 않는다 — 설정만 저장(읽기/스캔; 설치는 Phase G).
 */
export function SkillRootsSettings({ onToast }: { onToast: (msg: string) => void }) {
  const roots = useSkillUserRoots();
  const setRoots = useSetSkillUserRoots();

  const [draft, setDraft] = useState("");

  const list = roots.data ?? [];

  const persist = (next: { path: string }[], successMsg: string) => {
    setRoots.mutate(next, {
      onSuccess: () => onToast(successMsg),
      onError: (e) => onToast(String(e)),
    });
  };

  const add = () => {
    const path = draft.trim();
    if (!path || setRoots.isPending) return;
    if (list.some((r) => r.path === path)) {
      onToast("이미 등록된 루트입니다.");
      return;
    }
    persist([...list, { path }], "스킬 루트 추가됨");
    setDraft("");
  };

  const remove = (path: string) => {
    if (setRoots.isPending) return;
    persist(
      list.filter((r) => r.path !== path),
      "스킬 루트 제거됨",
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">사용자 스킬 루트</span>
      </div>

      <p className="text-muted-foreground text-xs">
        기본 감지 위치(~/.claude·~/.codex·~/.openclaw·레포 로컬) 밖의 스킬 디렉터리를 직접
        등록합니다. <strong>절대 경로</strong>만 허용되며(상대 경로는 거부), 아직 만들지 않은
        디렉터리도 미리 등록할 수 있습니다. 등록한 루트는 스캔과 편집 경로 가드에 함께 적용됩니다.
      </p>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>등록된 루트</SectionLabel>
        {roots.isLoading && <p className="text-muted-foreground text-sm">불러오는 중…</p>}
        {roots.isError && (
          <p className="text-xs text-[color:var(--destructive)]">
            루트 로드 실패: {String(roots.error)}
          </p>
        )}
        {roots.data && list.length === 0 && (
          <p className="text-muted-foreground text-sm">아직 등록된 사용자 루트가 없습니다.</p>
        )}
        {list.map((r) => (
          <div key={r.path} className="flex items-center gap-2 py-1">
            <span className="text-foreground min-w-0 flex-1 truncate font-mono text-[13px]">
              {r.path}
            </span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground px-1 text-xs transition-colors"
              onClick={() => remove(r.path)}
              disabled={setRoots.isPending}
              aria-label={`${r.path} 루트 제거`}
              title="루트 제거"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="/absolute/path/to/skills"
          aria-label="스킬 루트 절대 경로"
          className="font-mono text-[13px]"
        />
        <Button size="sm" onClick={add} disabled={setRoots.isPending || draft.trim() === ""}>
          {setRoots.isPending ? "저장 중…" : "추가"}
        </Button>
      </div>
    </div>
  );
}

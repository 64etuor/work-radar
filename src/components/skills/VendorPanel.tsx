import { Copy, Unlink } from "lucide-react";
import { useMemo, useState } from "react";

import type { Skill } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  useSkillDivergences,
  useSkillWorkspaces,
  useUnvendorSkillFromProject,
  useVendorSkillToProject,
} from "@/lib/query";
import { buildVendorTargets } from "@/lib/skillEnvNav";

import { DivergenceResolver } from "./DivergencePanel";

/** managed 스킬을 프로젝트 스킬 dir에 복사/해제(G3-PR2b, ADR-0006 레일 ① — 복사·가역·감사). vendorable
 *  프로젝트별 현재 상태: absent→복사, in_sync→복사 해제, diverged→해소(pull/push, G3-PR2c). 상태는
 *  divergences가 단일 출처(C6). vendorable provider(claude/codex) 아니거나 대상 프로젝트 없으면 숨김. */
export function VendorPanel({ skill }: { skill: Skill }) {
  const workspaces = useSkillWorkspaces();
  const divergences = useSkillDivergences();
  const vendor = useVendorSkillToProject();
  const unvendor = useUnvendorSkillFromProject();
  const [note, setNote] = useState<string | null>(null);
  const targets = useMemo(
    () => buildVendorTargets(skill, workspaces.data, divergences.data),
    [skill, workspaces.data, divergences.data],
  );
  if (!skill.provider || targets.length === 0) return null;
  const provider = skill.provider;
  const busy = vendor.isPending || unvendor.isPending;

  const doVendor = (repoId: string) => {
    if (busy) return;
    setNote(null);
    vendor.mutate(
      { repoId, provider, name: skill.name },
      {
        onSuccess: (path) => setNote(`복사됨 → ${path}`),
        onError: (e) => setNote(`복사 실패: ${(e as Error).message}`),
      },
    );
  };
  const doUnvendor = (repoId: string) => {
    if (busy) return;
    setNote(null);
    unvendor.mutate(
      { repoId, provider, name: skill.name },
      {
        onSuccess: () => setNote("복사 해제됨 (프로젝트 카피 제거 · 중앙 무손상)"),
        onError: (e) => setNote(`해제 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-vendor">
      <div className="skl-vendor-label">프로젝트에 복사</div>
      {targets.map((t) => (
        <div key={t.repoId} className="skl-vendor-row">
          <span className="skl-vendor-proj" title={t.repoId}>
            {t.label}
          </span>
          {t.state === "absent" && (
            <Button
              variant="outline"
              className="gap-1.5 rounded-full"
              onClick={() => doVendor(t.repoId)}
              disabled={busy}
            >
              <Copy className="size-4" />
              복사
            </Button>
          )}
          {t.state === "in_sync" && (
            <Button
              variant="outline"
              className="gap-1.5 rounded-full"
              onClick={() => doUnvendor(t.repoId)}
              disabled={busy}
            >
              <Unlink className="size-4" />
              복사 해제
            </Button>
          )}
          {t.state === "diverged" && (
            <DivergenceResolver
              repoId={t.repoId}
              provider={provider}
              name={skill.name}
              onResolved={setNote}
            />
          )}
        </div>
      ))}
      {note && <div className="skl-note">{note}</div>}
    </div>
  );
}

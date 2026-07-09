import { Download } from "lucide-react";
import { useState } from "react";

import type { SkillProvider } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useInstallSkillFromGit,
  useSkillEnvironments,
  useSkillWorkspaces,
  useVendorSkillToProject,
} from "@/lib/query";
import { buildInstallProviderOptions, VENDORABLE_PROVIDERS } from "@/lib/skillEnvNav";

/** 프로젝트 대상 미선택(라이브러리에만 설치) 센티넬 — radix Select는 빈 문자열 value 금지. */
const PROJECT_NONE = "__library_only__";

/** GitHub URL에서 스킬 설치 패널(G1.5-PR1, ADR-0006 레일 ③). URL + provider 선택 → 중앙 라이브러리로
 * 설치(가역·감사). 네트워크/토큰은 Rust(렌더러 비노출). 공개 repo 우선 — 비공개 인증은 후속 라운드.
 * 자동 실행 없음(#1/#2 — tarball 받아 파일 복사일 뿐). */
export function InstallPanel({ onDone }: { onDone: (id: string | null) => void }) {
  const install = useInstallSkillFromGit();
  const vendor = useVendorSkillToProject();
  // 설치 대상 provider 옵션은 detect로 present인 에이전트만(D5a) — 부재 에이전트는 숨김. "기타"는 항상.
  const environments = useSkillEnvironments();
  // 프로젝트 scope 설치 대상(D5b) — vendoring 가능한 등록 프로젝트(레포). 기존 vendor 인프라 재사용.
  const workspaces = useSkillWorkspaces();
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<SkillProvider>("claude");
  // 설치 후 vendor할 프로젝트(레포) id — PROJECT_NONE이면 라이브러리에만 설치.
  const [projectId, setProjectId] = useState<string>(PROJECT_NONE);
  const [note, setNote] = useState<string | null>(null);

  const providerOptions = buildInstallProviderOptions(environments.data);
  // 선택된 provider가 더 이상 옵션에 없으면(감지 변동) 첫 옵션으로 보정.
  if (providerOptions.length > 0 && !providerOptions.some((o) => o.provider === provider)) {
    setProvider(providerOptions[0].provider);
  }
  // 프로젝트 scope는 vendoring 가능한 provider(claude/codex) + 등록된 프로젝트가 있을 때만 제공.
  const projectTargets = workspaces.data ?? [];
  const canScopeProject = VENDORABLE_PROVIDERS.has(provider) && projectTargets.length > 0;
  // 선택된 프로젝트가 더 이상 유효하지 않으면(목록 변동/provider 비대상) 라이브러리 전용으로 복귀.
  if (
    projectId !== PROJECT_NONE &&
    (!canScopeProject || !projectTargets.some((w) => w.repoId === projectId))
  ) {
    setProjectId(PROJECT_NONE);
  }

  const submit = () => {
    const u = url.trim();
    if (!u || install.isPending || vendor.isPending) return;
    setNote(null);
    const targetRepo = canScopeProject && projectId !== PROJECT_NONE ? projectId : null;
    install.mutate(
      { url: u, provider },
      {
        onSuccess: (s) => {
          // 라이브러리 전용이면 그대로 완료. 프로젝트 scope면 설치된 managed 스킬을 그 프로젝트
          // dir(.claude|.codex/skills)에 vendor(기존 명령 재사용 — 새 백엔드 테이블 없음). 자동 실행 없음.
          if (!targetRepo || !s.provider) {
            onDone(s.id);
            return;
          }
          vendor.mutate(
            { repoId: targetRepo, provider: s.provider, name: s.name },
            {
              onSuccess: () => onDone(s.id),
              // 설치 자체는 성공 — vendor만 실패. 라이브러리엔 들어갔으니 시트는 그 스킬로 연다.
              onError: (e) => {
                setNote(`라이브러리 설치됨 · 프로젝트 복사 실패: ${(e as Error).message}`);
                onDone(s.id);
              },
            },
          );
        },
        onError: (e) => setNote(`설치 실패: ${(e as Error).message}`),
      },
    );
  };

  const busy = install.isPending || vendor.isPending;

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-mono"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="github.com/owner/repo[@ref][#subpath]"
          aria-label="설치할 GitHub repo URL"
        />
        <Select value={provider} onValueChange={(v) => setProvider(v as SkillProvider)}>
          <SelectTrigger className="w-auto min-w-[120px]" aria-label="대상 provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerOptions.map((o) => (
              <SelectItem key={o.provider} value={o.provider}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {canScopeProject && (
        <div className="skl-install-scope">
          <span className="skl-bind-line">프로젝트에 설치(선택)</span>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-full" aria-label="설치 대상 프로젝트">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PROJECT_NONE}>라이브러리에만 설치</SelectItem>
              {projectTargets.map((w) => (
                <SelectItem key={w.repoId} value={w.repoId}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <p className="skl-desc">
        공개 GitHub repo의 스킬을 라이브러리로 설치합니다. 네트워크 호출은 Rust에서 bounded로
        처리되고 모든 쓰기는 감사됩니다.
        {canScopeProject &&
          " 프로젝트를 고르면 설치 후 그 프로젝트의 스킬 dir에도 복사됩니다(가역·감사)."}{" "}
        스킬은 설치만 되며 자동 실행되지 않습니다.
      </p>
      <div className="skl-actions">
        <Button
          size="pill"
          className="gap-1.5 px-4"
          onClick={submit}
          disabled={!url.trim() || busy}
        >
          <Download className="size-4" />
          {busy ? "설치 중…" : "설치"}
        </Button>
        <Button variant="outline" size="pill" className="px-4" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

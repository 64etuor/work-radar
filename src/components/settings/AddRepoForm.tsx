import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderSearch, Plus } from "lucide-react";

import type { Provider } from "@/bindings";
import { useCreateRepo } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "./SettingsKit";

/** Add Repo 폼 (프로젝트 카드 내부). github=remote URL, local=경로(Codex worktree 베이스). */
export function AddRepoForm({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const create = useCreateRepo();
  const [provider, setProvider] = useState<Provider>("github");
  const [location, setLocation] = useState("");
  const [branch, setBranch] = useState("");

  // 폴더 picker: local 경로는 붙여넣기 대신 OS 다이얼로그로 선택한다.
  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setLocation(selected);
  };

  const submit = () => {
    if (!location.trim() || create.isPending) return;
    create.mutate(
      {
        projectId,
        provider,
        remoteUrl: provider === "github" ? trimOrNull(location) : null,
        localPath: provider === "local" ? trimOrNull(location) : null,
        defaultBranch: trimOrNull(branch),
      },
      {
        onSuccess: () => {
          setLocation("");
          setBranch("");
          onToast("레포 추가됨");
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-dashed border-border p-3.5">
      <div className="flex items-center justify-between gap-3">
        <Segmented
          size="sm"
          value={provider}
          onChange={setProvider}
          options={[
            { value: "github", label: "GitHub" },
            { value: "local", label: "Local" },
          ]}
        />
      </div>

      {provider === "github" ? (
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://github.com/org/repo"
          className="font-mono"
        />
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={location}
            readOnly
            placeholder="폴더를 선택하세요…"
            title={location || "선택된 폴더 없음"}
            className="font-mono"
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={pickFolder}>
            <FolderSearch className="size-3.5" />
            폴더 선택
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="기본 브랜치 (비면 main)"
          className="font-mono"
        />
        <Button
          size="sm"
          className="shrink-0"
          onClick={submit}
          disabled={!location.trim() || create.isPending}
        >
          <Plus className="size-3.5" />
          {create.isPending ? "추가 중…" : "추가"}
        </Button>
      </div>

      {create.isError && (
        <div className="text-xs text-[color:var(--destructive)]">{String(create.error)}</div>
      )}
    </div>
  );
}

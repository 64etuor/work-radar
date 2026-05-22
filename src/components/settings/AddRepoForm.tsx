import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Provider } from "@/bindings";
import { useCreateRepo } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";

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
  const [ticketPattern, setTicketPattern] = useState("");

  // 폴더 picker (Phase 14): local 경로는 붙여넣기 대신 OS 다이얼로그로 선택한다.
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
        ticketKeyPattern: trimOrNull(ticketPattern),
      },
      {
        onSuccess: () => {
          setLocation("");
          setBranch("");
          setTicketPattern("");
          onToast("레포 추가됨");
        },
      },
    );
  };

  return (
    <div className="st-repoform">
      <div className="st-seg sm">
        <button
          type="button"
          className={provider === "github" ? "on" : ""}
          onClick={() => setProvider("github")}
        >
          GitHub
        </button>
        <button
          type="button"
          className={provider === "local" ? "on" : ""}
          onClick={() => setProvider("local")}
        >
          Local
        </button>
      </div>
      {provider === "github" ? (
        <input
          className="st-input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://github.com/org/repo"
        />
      ) : (
        <div className="st-token-row">
          <input
            className="st-input"
            value={location}
            readOnly
            placeholder="폴더를 선택하세요…"
            title={location || "선택된 폴더 없음"}
          />
          <button type="button" className="st-btn sm" onClick={pickFolder}>
            폴더 선택
          </button>
        </div>
      )}
      <div className="st-repoform-row">
        <input
          className="st-input"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="기본 브랜치 (비면 main)"
        />
        <input
          className="st-input"
          value={ticketPattern}
          onChange={(e) => setTicketPattern(e.target.value)}
          placeholder="티켓 패턴 (선택)"
        />
        <button
          type="button"
          className="st-btn sm"
          onClick={submit}
          disabled={!location.trim() || create.isPending}
        >
          추가
        </button>
      </div>
      {create.isError && <div className="st-err">{String(create.error)}</div>}
    </div>
  );
}

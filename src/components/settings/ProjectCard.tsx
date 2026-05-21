import { useState } from "react";

import type { Project } from "@/bindings";
import {
  useProjectTokenStatus,
  useRepos,
  useSetNotionDoneStatuses,
} from "@/lib/query";

import { AddRepoForm } from "./AddRepoForm";
import { TokenRow } from "./TokenRow";

/** notionDoneStatuses(JSON 배열 문자열)를 쉼표 구분 문자열로. 깨진 JSON이면 빈 문자열. */
function parseDoneStatuses(raw: string | null): string {
  if (!raw) return "";
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.join(", ") : "";
  } catch {
    return "";
  }
}

/**
 * mismatch 판정용 "완료(done) 상태" 편집기 (Phase 6). 쉼표로 여러 개. 비우면 mismatch 감지 비활성.
 * PR이 머지됐는데 Notion 백로그 상태가 이 목록에 없으면 drift로 본다.
 */
function DoneStatusEditor({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const setStatuses = useSetNotionDoneStatuses();
  const [value, setValue] = useState(() =>
    parseDoneStatuses(project.notionDoneStatuses),
  );

  const save = () => {
    if (setStatuses.isPending) return;
    const statuses = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setStatuses.mutate(
      { projectId: project.id, statuses },
      {
        onSuccess: () =>
          onToast(
            statuses.length > 0
              ? `완료 상태 ${statuses.length}개 저장`
              : "완료 상태 비움 (mismatch 감지 끔)",
          ),
      },
    );
  };

  return (
    <div className="st-done">
      <input
        className="st-input sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder="예: Done, 완료, Shipped (쉼표 구분)"
      />
      <button
        type="button"
        className="st-btn-ghost sm"
        onClick={save}
        disabled={setStatuses.isPending}
      >
        저장
      </button>
    </div>
  );
}

/** 프로젝트 한 장: 토큰(Notion/GitHub) + 레포 목록 + Add Repo. */
export function ProjectCard({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const repos = useRepos(project.id);
  const tokenStatus = useProjectTokenStatus(project.id);

  return (
    <div className="st-proj">
      <div className="st-proj-head">
        <span className="st-proj-name">{project.name}</span>
        <span className={`st-chip ${project.kind === "personal" ? "personal" : "work"}`}>
          {project.kind === "personal" ? "개인" : "업무"}
        </span>
        {project.ticketKeyPattern && (
          <span className="st-proj-meta">패턴 {project.ticketKeyPattern}</span>
        )}
      </div>

      <div className="st-proj-body">
        <div className="st-subhead">토큰 (keychain)</div>
        <TokenRow
          projectId={project.id}
          kind="notion"
          label="Notion"
          hasToken={tokenStatus.data?.hasNotion ?? false}
          onToast={onToast}
        />
        <TokenRow
          projectId={project.id}
          kind="github"
          label="GitHub"
          hasToken={tokenStatus.data?.hasGithub ?? false}
          onToast={onToast}
        />

        <div className="st-subhead">Notion 완료 상태 (mismatch 기준)</div>
        <DoneStatusEditor project={project} onToast={onToast} />

        <div className="st-subhead">레포</div>
        {repos.isError && <div className="st-err">{String(repos.error)}</div>}
        {repos.data && repos.data.length === 0 && (
          <div className="st-empty">아직 레포가 없습니다.</div>
        )}
        {repos.data?.map((r) => (
          <div key={r.id} className="st-repo">
            <span className={`st-repo-prov ${r.provider}`}>
              {r.provider === "github" ? "GitHub" : "Local"}
            </span>
            <span className="st-repo-loc">{r.remoteUrl ?? r.localPath ?? "—"}</span>
            <span className="st-repo-branch">{r.defaultBranch}</span>
          </div>
        ))}
        <AddRepoForm projectId={project.id} onToast={onToast} />
      </div>
    </div>
  );
}

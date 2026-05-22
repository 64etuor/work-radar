import { useState } from "react";

import type { Project, PromotionTarget } from "@/bindings";
import { useProjectTokenStatus, useRepos, useTestNotionConnection } from "@/lib/query";

import { AddRepoForm } from "./AddRepoForm";
import { GoogleCalendarBlock } from "./GoogleCalendarBlock";
import { TokenRow } from "./TokenRow";

/** Notion DB 연결 테스트 버튼 + 인라인 결과 표시. */
function NotionDbTestButton({
  projectId,
  target,
  dbId,
}: {
  projectId: string;
  target: PromotionTarget;
  dbId: string;
}) {
  const test = useTestNotionConnection();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const run = () => {
    setResult(null);
    test.mutate(
      { projectId, target },
      {
        onSuccess: (msg) => setResult({ ok: true, msg }),
        onError: (e) => setResult({ ok: false, msg: String(e) }),
      },
    );
  };

  return (
    <div className="st-field">
      <span className="st-label">
        {target === "notion_backlog" ? "백로그 DB" : "안건 DB"}
      </span>
      <span className="st-proj-meta" style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
        {dbId}
      </span>
      <button
        type="button"
        className="st-btn-ghost sm"
        onClick={run}
        disabled={test.isPending}
        style={{ marginLeft: "auto" }}
      >
        {test.isPending ? "테스트 중…" : "연결 테스트"}
      </button>
      {result && (
        <div className={result.ok ? "st-ok" : "st-err"} style={{ marginTop: "0.25rem" }}>
          {result.msg}
        </div>
      )}
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

        {(project.notionBacklogDbId || project.notionAgendaDbId) && (
          <>
            <div className="st-subhead">Notion DB 연결</div>
            {project.notionBacklogDbId && (
              <NotionDbTestButton
                projectId={project.id}
                target="notion_backlog"
                dbId={project.notionBacklogDbId}
              />
            )}
            {project.notionAgendaDbId && (
              <NotionDbTestButton
                projectId={project.id}
                target="notion_agenda"
                dbId={project.notionAgendaDbId}
              />
            )}
          </>
        )}

        <div className="st-subhead">Google Calendar (keychain · read-only)</div>
        <GoogleCalendarBlock projectId={project.id} onToast={onToast} />

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

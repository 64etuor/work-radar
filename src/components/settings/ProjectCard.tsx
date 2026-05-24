import { useState } from "react";
import { FolderGit2, FolderOpen, Github, Plus } from "lucide-react";

import type { Project, PromotionTarget } from "@/bindings";
import {
  useProjectTokenStatus,
  useRepos,
  useTestNotionConnection,
} from "@/lib/query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { AddRepoForm } from "./AddRepoForm";
import { GoogleCalendarBlock } from "./GoogleCalendarBlock";
import { TokenRow } from "./TokenRow";
import { SectionLabel } from "./kit";

/** Notion DB 연결 테스트 버튼 + 인라인 결과. */
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
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {target === "notion_backlog" ? "백로그 DB" : "안건 DB"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {dbId}
        </span>
        <Button variant="outline" size="sm" onClick={run} disabled={test.isPending}>
          {test.isPending ? "테스트 중…" : "연결 테스트"}
        </Button>
      </div>
      {result && (
        <div
          className={`mt-2 text-xs ${
            result.ok ? "text-[color:var(--success)]" : "text-[color:var(--destructive)]"
          }`}
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}

function RepoRow({
  provider,
  loc,
  branch,
}: {
  provider: string;
  loc: string;
  branch: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3.5 py-2.5">
      {provider === "github" ? (
        <Github className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{loc}</span>
      <Badge variant="outline">{branch}</Badge>
    </div>
  );
}

/** 프로젝트 한 장: 토큰(Notion/GitHub) + Notion DB + 캘린더 + 레포. */
export function ProjectCard({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const repos = useRepos(project.id);
  const tokenStatus = useProjectTokenStatus(project.id);
  const hasNotionDb = !!(project.notionBacklogDbId || project.notionAgendaDbId);

  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
          <FolderOpen className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{project.name}</span>
            <Badge variant={project.kind === "personal" ? "secondary" : "accent"}>
              {project.kind === "personal" ? "개인" : "업무"}
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 border-t border-border px-5 py-5">
        <div className="flex flex-col gap-2.5">
          <SectionLabel>토큰 · keychain</SectionLabel>
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
        </div>

        {hasNotionDb && (
          <div className="flex flex-col gap-2.5">
            <SectionLabel>Notion DB 연결</SectionLabel>
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
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          <SectionLabel>Google Calendar</SectionLabel>
          <GoogleCalendarBlock projectId={project.id} onToast={onToast} />
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <SectionLabel>레포</SectionLabel>
          </div>
          {repos.isError && (
            <div className="text-xs text-[color:var(--destructive)]">
              {String(repos.error)}
            </div>
          )}
          {repos.data && repos.data.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Plus className="size-3.5" />
              아직 레포가 없습니다 — 아래에서 추가하세요.
            </div>
          )}
          {repos.data?.map((r) => (
            <RepoRow
              key={r.id}
              provider={r.provider}
              loc={r.remoteUrl ?? r.localPath ?? "—"}
              branch={r.defaultBranch}
            />
          ))}
          <AddRepoForm projectId={project.id} onToast={onToast} />
        </div>
      </div>
    </Card>
  );
}

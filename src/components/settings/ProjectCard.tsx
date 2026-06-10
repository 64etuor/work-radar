import {
  AlertTriangle,
  CircleUserRound,
  FolderOpen,
  Github,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { Project } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { useDeleteProject, useProjectTokenStatus, useRepos } from "@/lib/query";

import { AddRepoForm } from "./AddRepoForm";
import { GoogleAccountBlock } from "./GoogleAccountBlock";
import { BouleConfigControls } from "./project-card/BouleConfigControls";
import { NotionDbEditor } from "./project-card/NotionDbEditor";
import { ProjectCalendarColorControl } from "./project-card/ProjectCalendarColorControl";
import { ProjectIdentityEditor } from "./project-card/ProjectIdentityEditor";
import { RepoRow } from "./project-card/RepoRow";
import { SectionLabel } from "./SettingsKit";
import { TokenRow } from "./TokenRow";

/** 프로젝트 한 장: 토큰(Notion/GitHub) + Notion DB + Google 계정 + 레포. */
export function ProjectCard({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const repos = useRepos(project.id);
  const tokenStatus = useProjectTokenStatus(project.id);
  const deleteProject = useDeleteProject();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDeleteProject = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteProject.mutate(project.id, {
      onSuccess: () => onToast(`프로젝트 삭제됨: ${project.name}`),
      onError: (e) => onToast(`프로젝트 삭제 실패: ${String(e)}`),
    });
  };

  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="flex items-start gap-3 p-5">
        <div className="border-border bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl border">
          <FolderOpen className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <ProjectIdentityEditor project={project} onToast={onToast} />
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            토큰은 OS keychain에 저장하고, Notion/GitHub/Google 계정 연결은 이 프로젝트 범위에서만
            사용합니다.
          </p>
        </div>
      </div>

      <div className="border-border flex flex-col gap-4 border-t p-5">
        <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="text-muted-foreground size-4" />
            <SectionLabel>토큰 · keychain</SectionLabel>
          </div>
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

        <NotionDbEditor project={project} onToast={onToast} />

        <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <CircleUserRound className="text-muted-foreground size-4" />
            <SectionLabel>Google 계정</SectionLabel>
          </div>
          <ProjectCalendarColorControl project={project} onToast={onToast} />
          <GoogleAccountBlock projectId={project.id} onToast={onToast} />
        </div>

        <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Github className="text-muted-foreground size-4" />
              <SectionLabel>레포</SectionLabel>
            </div>
          </div>
          {repos.isError && (
            <div className="text-xs text-[color:var(--destructive)]">{String(repos.error)}</div>
          )}
          {repos.data && repos.data.length === 0 && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Plus className="size-3.5" />
              아직 레포가 없습니다. 아래에서 추가하세요.
            </div>
          )}
          {repos.data?.map((r) => (
            <div key={r.id} className="flex flex-col gap-2">
              <RepoRow
                repoId={r.id}
                projectId={project.id}
                provider={r.provider}
                loc={r.remoteUrl ?? r.localPath ?? "—"}
                branch={r.defaultBranch}
                onToast={onToast}
              />
              {r.provider === "local" && <BouleConfigControls repoId={r.id} onToast={onToast} />}
            </div>
          ))}
          <AddRepoForm projectId={project.id} onToast={onToast} />
        </div>

        <div className="border-destructive/30 bg-destructive/5 flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-destructive size-4" />
            <SectionLabel>프로젝트 삭제</SectionLabel>
          </div>
          <p className="text-muted-foreground text-xs leading-5">
            프로젝트 행과 레포 연결을 삭제합니다. 완료 기록과 루틴은 남기고 프로젝트 연결만
            해제합니다.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={confirmDelete ? "destructive" : "outline"}
              size="sm"
              onClick={handleDeleteProject}
              disabled={deleteProject.isPending}
              className={cn(!confirmDelete && "text-destructive hover:text-destructive")}
            >
              <Trash2 className="size-3.5" />
              {deleteProject.isPending ? "삭제 중" : confirmDelete ? "정말 삭제" : "삭제"}
            </Button>
            {confirmDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteProject.isPending}
              >
                취소
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

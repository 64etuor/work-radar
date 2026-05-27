import { useState } from "react";
import {
  CircleUserRound,
  FolderGit2,
  FolderOpen,
  Github,
  KeyRound,
  Plus,
} from "lucide-react";

import type { Project, PromotionTarget } from "@/bindings";
import {
  useProjectTokenStatus,
  useRepos,
  useSetProjectCalendarColor,
  useTestNotionConnection,
} from "@/lib/query";
import {
  calendarColorStyle,
  normalizeHexColor,
  projectCalendarColors,
  PROJECT_CALENDAR_PALETTE,
} from "@/lib/projectCalendarColor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { AddRepoForm } from "./AddRepoForm";
import { GoogleAccountBlock } from "./GoogleAccountBlock";
import { TokenRow } from "./TokenRow";
import { SectionLabel } from "./SettingsKit";

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

function ProjectCalendarColorControl({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const colors = projectCalendarColors(project.id, project.calendarColor);
  const [draft, setDraft] = useState(colors.background);
  const saveColor = useSetProjectCalendarColor();
  const normalizedDraft = normalizeHexColor(draft);
  const savedBackground = normalizeHexColor(project.calendarColor ?? null) ?? colors.background;
  const preview = normalizedDraft
    ? projectCalendarColors(project.id, normalizedDraft)
    : colors;
  const dirty = normalizedDraft !== savedBackground;

  const save = (color: string | null) => {
    if (saveColor.isPending) return;
    saveColor.mutate(
      { projectId: project.id, color },
      {
        onSuccess: () => {
          setDraft(projectCalendarColors(project.id, color).background);
          onToast(color ? "캘린더 색상 저장됨" : "캘린더 색상 기본값으로 복원됨");
        },
      },
    );
  };

  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-flex min-w-[104px] items-center justify-center rounded-md border px-3 py-1.5 text-xs font-semibold"
          style={calendarColorStyle(preview.background, preview.foreground)}
        >
          {project.name}
        </span>
        <input
          type="color"
          value={normalizedDraft ?? colors.background}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="프로젝트 캘린더 색상"
          className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
        />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 w-[112px] font-mono text-xs"
          aria-label="프로젝트 캘린더 색상 hex"
        />
        <div className="flex items-center gap-1">
          {PROJECT_CALENDAR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`색상 ${color}`}
              className="size-5 rounded-full border border-border"
              style={{ backgroundColor: color }}
              onClick={() => setDraft(color)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => save(null)}
            disabled={saveColor.isPending || !project.calendarColor}
          >
            기본값
          </Button>
          <Button
            size="sm"
            onClick={() => normalizedDraft && save(normalizedDraft)}
            disabled={saveColor.isPending || !normalizedDraft || !dirty}
          >
            저장
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        배경색만 저장합니다. 일정 제목과 캘린더명 글자색은 대비 기준으로 자동 조정됩니다.
      </p>
    </div>
  );
}

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
  const hasNotionDb = !!(project.notionBacklogDbId || project.notionAgendaDbId);

  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="flex items-start gap-3 px-5 py-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
          <FolderOpen className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">
              {project.name}
            </span>
            <Badge variant={project.kind === "personal" ? "secondary" : "accent"}>
              {project.kind === "personal" ? "개인" : "업무"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            토큰은 OS keychain에 저장하고, Notion/GitHub/Google 계정 연결은 이 프로젝트 범위에서만 사용합니다.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-border px-5 py-5">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
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

        {hasNotionDb && (
          <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/15 p-4">
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

        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex items-center gap-2">
            <CircleUserRound className="size-4 text-muted-foreground" />
            <SectionLabel>Google 계정</SectionLabel>
          </div>
          <ProjectCalendarColorControl project={project} onToast={onToast} />
          <GoogleAccountBlock projectId={project.id} onToast={onToast} />
        </div>

        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Github className="size-4 text-muted-foreground" />
              <SectionLabel>레포</SectionLabel>
            </div>
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

import {
  CircleUserRound,
  FolderGit2,
  FolderOpen,
  Github,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import type { Project, ProjectKind, PromotionTarget } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import {
  calendarColorStyle,
  normalizeHexColor,
  PROJECT_CALENDAR_PALETTE,
  projectCalendarColors,
} from "@/lib/projectCalendarColor";
import {
  useDeleteRepo,
  useProjectTokenStatus,
  useRepos,
  useSetProjectCalendarColor,
  useSetProjectKind,
  useSetProjectName,
  useTestNotionConnection,
} from "@/lib/query";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

import { AddRepoForm } from "./AddRepoForm";
import { GmailBlock } from "./GmailBlock";
import { GoogleAccountBlock } from "./GoogleAccountBlock";
import { SectionLabel, Segmented } from "./SettingsKit";
import { TokenRow } from "./TokenRow";

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
    <div className="border-border rounded-lg border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {target === "notion_backlog" ? "백로그 DB" : "안건 DB"}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
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
  repoId,
  projectId,
  provider,
  loc,
  branch,
  onToast,
}: {
  repoId: string;
  projectId: string;
  provider: string;
  loc: string;
  branch: string;
  onToast: (msg: string) => void;
}) {
  const del = useDeleteRepo();
  return (
    <div className="border-border flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
      {provider === "github" ? (
        <Github className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{loc}</span>
      <Badge variant="outline">{branch}</Badge>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-destructive size-7 shrink-0 p-0"
        aria-label="레포 연결 해제"
        title="레포 연결 해제"
        disabled={del.isPending}
        onClick={() =>
          del.mutate(
            { repoId, projectId },
            {
              onSuccess: () => onToast("레포 연결 해제됨"),
              onError: () => onToast("레포 제거 실패"),
            },
          )
        }
      >
        <Trash2 className="size-3.5" />
      </Button>
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
  const preview = normalizedDraft ? projectCalendarColors(project.id, normalizedDraft) : colors;
  // 서버 값이 바뀌면 드래프트도 동기화.
  const [seededFrom, setSeededFrom] = useState<string | null | undefined>(undefined);
  if (project.calendarColor !== seededFrom) {
    setSeededFrom(project.calendarColor ?? null);
    setDraft(colors.background);
  }

  const persist = useDebouncedCallback((color: string | null) => {
    saveColor.mutate({ projectId: project.id, color });
  }, 400);

  // hex 텍스트 입력: debounced + 유효 hex 가드. 픽커/팔레트/리셋은 flushNow로 즉시 반영.
  const onTypeHex = (value: string) => {
    setDraft(value);
    const normalized = normalizeHexColor(value);
    if (normalized && normalized !== savedBackground) persist.run(normalized);
    else persist.cancel();
  };

  const setColorImmediate = (value: string) => {
    setDraft(value);
    const normalized = normalizeHexColor(value);
    if (normalized && normalized !== savedBackground) persist.flushNow(normalized);
  };

  const resetToDefault = () => {
    persist.flushNow(null);
    onToast("캘린더 색상 기본값으로 복원됨");
  };

  return (
    <div className="border-border rounded-lg border px-4 py-3">
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
          onChange={(e) => setColorImmediate(e.target.value)}
          aria-label="프로젝트 캘린더 색상"
          className="border-border h-8 w-10 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <Input
          value={draft}
          onChange={(e) => onTypeHex(e.target.value)}
          className="h-8 w-[112px] font-mono text-xs"
          aria-label="프로젝트 캘린더 색상 hex"
        />
        <div className="flex items-center gap-1">
          {PROJECT_CALENDAR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`색상 ${color}`}
              className="border-border size-5 rounded-full border"
              style={{ backgroundColor: color }}
              onClick={() => setColorImmediate(color)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={resetToDefault}
            disabled={saveColor.isPending || !project.calendarColor}
          >
            기본값
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
        배경색만 저장합니다. 일정 제목과 캘린더명 글자색은 대비 기준으로 자동 조정됩니다.
      </p>
    </div>
  );
}

/**
 * 프로젝트 이름(더블클릭 인라인 편집) + 종류(개인/업무 Segmented 즉시 전환).
 * 이름: Enter/blur 저장, Esc 취소(셸 window-level Esc로 버블 방지), 공백 이름 거부.
 * kind: 토글 즉시 mutate — 라우팅 카테고리만 이동(기존 신호 재태깅 없음).
 */
function ProjectIdentityEditor({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const setName = useSetProjectName();
  const setKind = useSetProjectKind();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  const beginEdit = () => {
    setDraft(project.name);
    setEditing(true);
  };

  // 이름·kind는 각각 단일 컬럼만 갱신하는 독립 커맨드 → 교차 필드(stale prop)를 읽지 않는다(lost-update 방지).
  const commitName = () => {
    const trimmed = draft.trim();
    if (!trimmed) return; // 빈 이름 거부 — 편집 모드 유지(테두리 경고).
    if (trimmed === project.name) {
      setEditing(false);
      return;
    }
    setName.mutate(
      { projectId: project.id, name: trimmed },
      {
        onSuccess: () => setEditing(false),
        onError: () => onToast("이름 저장 실패"),
      },
    );
  };

  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitName();
    } else if (e.key === "Escape") {
      e.stopPropagation(); // App 셸 window-level Esc(보드 복귀/창 숨김)로 버블 방지.
      setEditing(false);
    }
  };

  const changeKind = (kind: ProjectKind) => {
    if (kind === project.kind) return;
    setKind.mutate({ projectId: project.id, kind }, { onError: () => onToast("종류 저장 실패") });
  };

  const empty = !draft.trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onNameKeyDown}
          onBlur={commitName}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
          disabled={setName.isPending}
          aria-invalid={empty || undefined}
          aria-label="프로젝트 이름"
          className={cn(
            "h-auto min-w-0 flex-1 border-0 border-b bg-transparent px-0 py-0 outline-none",
            "typo-title-md disabled:opacity-50",
            empty ? "border-destructive" : "border-input focus:border-ring focus:border-b-2",
          )}
        />
      ) : (
        <span
          className="typo-title-md cursor-text truncate"
          onDoubleClick={beginEdit}
          title="더블클릭하여 이름 편집"
        >
          {project.name}
        </span>
      )}
      <Segmented
        value={project.kind}
        onChange={changeKind}
        options={[
          { value: "personal", label: "개인" },
          { value: "work", label: "업무" },
        ]}
        size="sm"
      />
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

        {hasNotionDb && (
          <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
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

        <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <CircleUserRound className="text-muted-foreground size-4" />
            <SectionLabel>Google 계정</SectionLabel>
          </div>
          <ProjectCalendarColorControl project={project} onToast={onToast} />
          <GoogleAccountBlock projectId={project.id} onToast={onToast} />
          <GmailBlock projectId={project.id} onToast={onToast} />
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
            <RepoRow
              key={r.id}
              repoId={r.id}
              projectId={project.id}
              provider={r.provider}
              loc={r.remoteUrl ?? r.localPath ?? "—"}
              branch={r.defaultBranch}
              onToast={onToast}
            />
          ))}
          <AddRepoForm projectId={project.id} onToast={onToast} />
        </div>
      </div>
    </Card>
  );
}

import { useState } from "react";
import "./SettingsView.css";
import {
  Bell,
  Bot,
  Briefcase,
  FolderOpen,
  Keyboard,
  Link2,
  Moon,
  Newspaper,
  Plus,
  Sun,
  Tags,
  User,
} from "lucide-react";

import type { Project } from "@/bindings";
import { useProjects, useReconcileSignalProjects } from "@/lib/query";
import { useUIStore } from "@/store";
import { useToastStore } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KindBadge } from "@/components/board/LifeWheelPalette";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";

import { AddProjectForm } from "./settings/AddProjectForm";
import { HermesBridgeBlock } from "./settings/HermesBridgeBlock";
import { NavigationSettings } from "./settings/NavigationSettings";
import { NewsSourceSettings } from "./settings/NewsSourceSettings";
import { NotificationSettings } from "./settings/NotificationSettings";
import { ProjectCard } from "./settings/ProjectCard";
import { AgentsPane } from "./settings/AgentsPane";
import { GoogleAccountBlock } from "./settings/GoogleAccountBlock";
import { LifeWheelTagSettings } from "./settings/LifeWheelTagSettings";
import { SectionLabel } from "./settings/SettingsKit";

type SettingsCategory =
  | "projects"
  | "agents"
  | "shortcuts"
  | "integrations"
  | "notifications"
  | "news"
  | "tags";

const CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
}[] = [
  { id: "projects", label: "프로젝트", icon: FolderOpen, blurb: "개인/업무 프로젝트와 Notion·GitHub·Google 계정 연결을 관리합니다." },
  { id: "agents", label: "에이전트", icon: Bot, blurb: "Codex CLI 상태와 에이전트 모델을 설정합니다." },
  { id: "shortcuts", label: "단축키", icon: Keyboard, blurb: "뷰 전환 단축키와 키맵을 설정합니다." },
  { id: "integrations", label: "통합", icon: Link2, blurb: "Google 계정·Hermes 브리지 연결을 관리합니다." },
  { id: "notifications", label: "알림", icon: Bell, blurb: "데스크톱 알림과 트리거를 설정합니다." },
  { id: "news", label: "뉴스", icon: Newspaper, blurb: "보드 하단 티커에 표시할 외부 뉴스 소스를 켜고 끕니다." },
  { id: "tags", label: "태그", icon: Tags, blurb: "브레인덤프 카드의 Life Wheel 태그와 팔레트 색상을 관리합니다." },
];

const NEW_PROJECT_ID = "__new_project__";

/**
 * 설정 / 프로젝트 뷰 — 사이드바 + 콘텐츠 split (Cohere white editorial, shadcn).
 * Cmd+, 또는 cmdk 팔레트로 진입한다. 화면 전환은 전역 창/뷰 선택 로직이 담당한다.
 */
export function SettingsView() {
  const { settingsIntent, theme, toggleTheme } = useUIStore();
  const projects = useProjects();
  const reconcile = useReconcileSignalProjects();
  const { pushSuccess } = useToastStore();

  const [category, setCategory] = useState<SettingsCategory>("projects");

  const list = projects.data ?? [];
  const active = CATEGORIES.find((c) => c.id === category)!;

  const runReconcile = () => {
    reconcile.mutate(undefined, {
      onSuccess: (n) =>
        pushSuccess(n > 0 ? `${n}건 신호를 projectId로 태깅` : "태깅할 신호 없음"),
    });
  };

  return (
    <div className="settings flex h-full flex-col bg-background text-foreground">
      <header
        className="flex items-center gap-3 border-b border-border px-[22px] py-3.5"
        data-tauri-drag-region
      >
        <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em]">
          설정
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {active.label}
        </span>
        {category === "projects" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={runReconcile}
            disabled={reconcile.isPending || list.length === 0}
            title="미태깅 신호를 kind→프로젝트로 reconcile"
          >
            {reconcile.isPending ? "재정렬 중…" : "신호 projectId 재정렬"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={toggleTheme}
          className="ml-auto gap-1.5 rounded-full border-border text-[13px]"
          title="라이트/다크 전환"
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === "dark" ? "라이트" : "다크"}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 왼쪽 사이드바 */}
        <nav
          className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-muted/20 p-3"
          aria-label="설정 카테고리"
        >
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              onClick={() => setCategory(id)}
              aria-current={category === id ? "page" : undefined}
              className={`h-9 w-full justify-start gap-2.5 rounded-lg px-3 text-[13px] ${
                category === id
                  ? "bg-secondary hover:bg-secondary"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </Button>
          ))}
        </nav>

        {/* 오른쪽 콘텐츠 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto flex flex-col gap-5 px-7 py-6",
              category === "projects" ? "max-w-5xl" : "max-w-3xl",
            )}
          >
            <div className="border-b border-border pb-4">
              <SectionLabel>settings</SectionLabel>
              <h2 className="mt-2 text-[22px] font-semibold leading-tight tracking-[-0.02em]">
                {active.label}
              </h2>
              <p className="mt-1 max-w-[62ch] text-sm leading-6 text-muted-foreground">
                {active.blurb}
              </p>
            </div>

            {category === "projects" && (
              <ProjectsPane
                list={list}
                projects={projects}
                settingsIntent={settingsIntent}
                pushSuccess={pushSuccess}
              />
            )}
            {category === "agents" && <AgentsPane onToast={pushSuccess} />}
            {category === "shortcuts" && <NavigationSettings onToast={pushSuccess} />}
            {category === "integrations" && (
              <IntegrationsPane list={list} pushSuccess={pushSuccess} />
            )}
            {category === "notifications" && (
              <NotificationSettings onToast={pushSuccess} />
            )}
            {category === "news" && <NewsSourceSettings onToast={pushSuccess} />}
            {category === "tags" && <LifeWheelTagSettings onToast={pushSuccess} />}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── 카테고리 패널들 ──────────────────────────────────────────────────────

function ProjectsPane({
  list,
  projects,
  settingsIntent,
  pushSuccess,
}: {
  list: Project[];
  projects: ReturnType<typeof useProjects>;
  settingsIntent: string | null | undefined;
  pushSuccess: (msg: string) => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    settingsIntent === "add_project" ? NEW_PROJECT_ID : null,
  );
  const isCreating = selectedProjectId === NEW_PROJECT_ID || list.length === 0;
  const selectedId = !isCreating && list.some((p) => p.id === selectedProjectId)
    ? selectedProjectId
    : list[0]?.id;
  const selectedProject = list.find((p) => p.id === selectedId);

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="self-start overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <div>
            <SectionLabel>프로젝트</SectionLabel>
            <p className="mt-1 text-xs text-muted-foreground">
              설정할 프로젝트를 선택하세요.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{list.length}</Badge>
            <Button
              variant="outline"
              size="sm"
              className="size-7 rounded-full p-0"
              aria-label="새 프로젝트"
              title="새 프로젝트"
              onClick={() => setSelectedProjectId(NEW_PROJECT_ID)}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>

        {projects.isLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            불러오는 중…
          </div>
        )}
        {projects.isError && (
          <div className="px-4 py-6 text-sm text-[color:var(--destructive)]">
            프로젝트 로드 실패: {String(projects.error)}
          </div>
        )}
        {projects.data && list.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            아직 프로젝트가 없습니다. 오른쪽에서 첫 프로젝트를 추가하세요.
          </div>
        )}

        <div className="flex flex-col gap-1.5 p-2.5">
          <button
            type="button"
            onClick={() => setSelectedProjectId(NEW_PROJECT_ID)}
            aria-pressed={isCreating}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border border-dashed px-3 py-3 text-left transition-colors",
              isCreating
                ? "border-border-strong bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
              <Plus className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold">새 프로젝트</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                개인/업무 프로젝트 추가
              </span>
            </span>
          </button>

          {list.length > 0 &&
            list.map((p) => (
              <ProjectSelectTile
                key={p.id}
                project={p}
                selected={p.id === selectedId}
                onSelect={() => setSelectedProjectId(p.id)}
              />
            ))}
        </div>
      </Card>

      <div className="min-w-0">
        {isCreating ? (
          <AddProjectForm
            autoFocus={settingsIntent === "add_project"}
            onCreated={(msg, projectId) => {
              pushSuccess(msg);
              setSelectedProjectId(projectId ?? null);
            }}
          />
        ) : selectedProject ? (
          <ProjectCard key={selectedProject.id} project={selectedProject} onToast={pushSuccess} />
        ) : (
          <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
            프로젝트를 선택하면 토큰, Notion DB, Google 계정, 레포 설정을 볼 수 있습니다.
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectSelectTile({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = project.kind === "personal" ? User : Briefcase;
  const hasNotion = !!(project.notionBacklogDbId || project.notionAgendaDbId);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
        selected
          ? "border-border-strong bg-secondary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-hover hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border",
          selected ? "border-border bg-card" : "border-transparent bg-muted",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">
          {project.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          <KindBadge
            kind={project.kind}
            className="h-4 px-1.5 py-0 text-[10px] leading-none"
          />
          {hasNotion && (
            <>
              <span className="text-border-strong">·</span>
              <span>Notion</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function IntegrationsPane({
  list,
  pushSuccess,
}: {
  list: Project[];
  pushSuccess: (msg: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionLabel>Google 계정</SectionLabel>
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">
            프로젝트를 먼저 추가한 뒤 각 프로젝트에서 Google 계정을 연결하세요.
          </div>
        )}
        {list.map((p) => (
          <GoogleAccountBlock key={p.id} projectId={p.id} onToast={pushSuccess} />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Hermes 브리지</SectionLabel>
        <HermesBridgeBlock onToast={pushSuccess} />
      </div>
    </>
  );
}

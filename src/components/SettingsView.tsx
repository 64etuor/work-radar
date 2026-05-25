import { useState } from "react";
import {
  ArrowLeft,
  Bell,
  Bot,
  FolderOpen,
  Keyboard,
  Link2,
  Moon,
  Newspaper,
  Sun,
} from "lucide-react";

import type { Project } from "@/bindings";
import { useProjects, useReconcileSignalProjects } from "@/lib/query";
import { useUIStore } from "@/store";
import { useToastStore } from "@/lib/toast";
import { Button } from "@/components/ui/button";

import { AddProjectForm } from "./settings/AddProjectForm";
import { HermesBridgeBlock } from "./settings/HermesBridgeBlock";
import { NavigationSettings } from "./settings/NavigationSettings";
import { NewsSourceSettings } from "./settings/NewsSourceSettings";
import { NotificationSettings } from "./settings/NotificationSettings";
import { ProjectCard } from "./settings/ProjectCard";
import { AgentsPane } from "./settings/AgentsPane";
import { GoogleCalendarBlock } from "./settings/GoogleCalendarBlock";
import { SectionLabel } from "./settings/kit";

type SettingsCategory =
  | "projects"
  | "agents"
  | "shortcuts"
  | "integrations"
  | "notifications"
  | "news";

const CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
}[] = [
  { id: "projects", label: "프로젝트", icon: FolderOpen, blurb: "개인/업무 프로젝트와 Notion·GitHub·캘린더 연결을 관리합니다." },
  { id: "agents", label: "에이전트", icon: Bot, blurb: "Codex CLI 상태와 에이전트 모델을 설정합니다." },
  { id: "shortcuts", label: "단축키", icon: Keyboard, blurb: "뷰 전환 단축키와 키맵을 설정합니다." },
  { id: "integrations", label: "통합", icon: Link2, blurb: "Google Calendar·Hermes 브리지 연결을 관리합니다." },
  { id: "notifications", label: "알림", icon: Bell, blurb: "데스크톱 알림과 트리거를 설정합니다." },
  { id: "news", label: "뉴스", icon: Newspaper, blurb: "보드 하단 티커에 표시할 외부 뉴스 소스를 켜고 끕니다." },
];

/**
 * 설정 / 프로젝트 뷰 — 사이드바 + 콘텐츠 split (Cohere white editorial, shadcn).
 * Cmd+, 또는 cmdk 팔레트로 진입, Esc/← 로 보드 복귀.
 */
export function SettingsView() {
  const { goTo, settingsIntent, theme, toggleTheme } = useUIStore();
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
    <div className="flex h-full flex-col bg-background text-foreground">
      <header
        className="flex items-center gap-3 border-b border-border px-5 py-3"
        data-tauri-drag-region
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => goTo("board")}
          className="gap-1.5 rounded-full border-border text-[13px]"
        >
          <ArrowLeft className="size-4" />
          보드
        </Button>
        <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em]">
          설정
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
          className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-3"
          aria-label="설정 카테고리"
        >
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              onClick={() => setCategory(id)}
              aria-current={category === id ? "page" : undefined}
              className={`w-full justify-start gap-2.5 rounded-lg px-3 text-[13px] ${
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
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-7 py-7">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{active.label}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{active.blurb}</p>
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
  return (
    <>
      <AddProjectForm
        autoFocus={settingsIntent === "add_project"}
        onCreated={pushSuccess}
      />

      <div className="flex flex-col gap-3">
        <SectionLabel>프로젝트 ({list.length})</SectionLabel>

        {projects.isLoading && (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        )}
        {projects.isError && (
          <div className="text-sm text-[color:var(--destructive)]">
            프로젝트 로드 실패: {String(projects.error)}
          </div>
        )}
        {projects.data && list.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">
            아직 프로젝트가 없습니다 — 위에서 개인/업무 프로젝트를 추가하세요.
          </div>
        )}

        {list.map((p) => (
          <ProjectCard key={p.id} project={p} onToast={pushSuccess} />
        ))}
      </div>
    </>
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
        <SectionLabel>Google Calendar</SectionLabel>
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">
            프로젝트를 먼저 추가한 뒤 각 프로젝트에서 Google Calendar를 연결하세요.
          </div>
        )}
        {list.map((p) => (
          <GoogleCalendarBlock key={p.id} projectId={p.id} onToast={pushSuccess} />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Hermes 브리지</SectionLabel>
        <HermesBridgeBlock onToast={pushSuccess} />
      </div>
    </>
  );
}

import { useState } from "react";
import {
  ArrowLeft,
  Bell,
  FolderOpen,
  Keyboard,
  Link2,
  Bot,
} from "lucide-react";

import type { Project } from "@/bindings";
import { useProjects, useReconcileSignalProjects } from "@/lib/query";
import { useUIStore } from "@/store";
import { useToastStore } from "@/lib/toast";

import { AddProjectForm } from "./settings/AddProjectForm";
import { HermesBridgeBlock } from "./settings/HermesBridgeBlock";
import { NavigationSettings } from "./settings/NavigationSettings";
import { NotificationSettings } from "./settings/NotificationSettings";
import { ProjectCard } from "./settings/ProjectCard";
import { AgentsPane } from "./settings/AgentsPane";
import { GoogleCalendarBlock } from "./settings/GoogleCalendarBlock";

type SettingsCategory =
  | "projects"
  | "agents"
  | "shortcuts"
  | "integrations"
  | "notifications";

const CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "projects", label: "프로젝트", icon: FolderOpen },
  { id: "agents", label: "에이전트", icon: Bot },
  { id: "shortcuts", label: "단축키", icon: Keyboard },
  { id: "integrations", label: "통합", icon: Link2 },
  { id: "notifications", label: "알림", icon: Bell },
];

/**
 * 설정 / 프로젝트 뷰 (B2: macOS System-Settings-style split).
 * LEFT: 카테고리 사이드바. RIGHT: 선택된 카테고리 콘텐츠.
 * Cmd+, 또는 cmdk 팔레트로 진입, Esc/← 로 보드 복귀.
 */
export function SettingsView() {
  const { goTo, settingsIntent } = useUIStore();
  const projects = useProjects();
  const reconcile = useReconcileSignalProjects();
  const { pushSuccess } = useToastStore();

  // 기본 카테고리: Projects(첫 번째). add_project intent는 폼 autoFocus로 처리(아래).
  const [category, setCategory] = useState<SettingsCategory>("projects");

  const list = projects.data ?? [];

  const runReconcile = () => {
    reconcile.mutate(undefined, {
      onSuccess: (n) =>
        pushSuccess(n > 0 ? `${n}건 신호를 projectId로 태깅` : "태깅할 신호 없음"),
    });
  };

  return (
    <div className="settings">
      <header className="st-head" data-tauri-drag-region>
        <button type="button" className="st-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="st-title">설정</span>
        {category === "projects" && (
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={runReconcile}
            disabled={reconcile.isPending || list.length === 0}
            title="미태깅 신호를 kind→프로젝트로 reconcile"
          >
            {reconcile.isPending ? "재정렬 중…" : "신호 projectId 재정렬"}
          </button>
        )}
      </header>

      <div className="settings-split">
        {/* 왼쪽 사이드바 */}
        <nav className="set-sidebar" aria-label="설정 카테고리">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`set-sidebar-item${category === id ? " active" : ""}`}
              onClick={() => setCategory(id)}
              aria-current={category === id ? "page" : undefined}
            >
              <Icon className="set-sidebar-icon size-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* 오른쪽 콘텐츠 */}
        <main className="set-pane">
          {category === "projects" && (
            <ProjectsPane
              list={list}
              projects={projects}
              settingsIntent={settingsIntent}
              pushSuccess={pushSuccess}
            />
          )}
          {category === "agents" && (
            <AgentsPane onToast={pushSuccess} />
          )}
          {category === "shortcuts" && (
            <NavigationSettings onToast={pushSuccess} />
          )}
          {category === "integrations" && (
            <IntegrationsPane list={list} pushSuccess={pushSuccess} />
          )}
          {category === "notifications" && (
            <NotificationSettings onToast={pushSuccess} />
          )}
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

      <div className="st-section-lbl">프로젝트 ({list.length})</div>

      {projects.isLoading && <div className="st-empty">불러오는 중…</div>}
      {projects.isError && (
        <div className="st-err">프로젝트 로드 실패: {String(projects.error)}</div>
      )}
      {projects.data && list.length === 0 && (
        <div className="st-empty">
          아직 프로젝트가 없습니다 — 위에서 개인/업무 프로젝트를 추가하세요.
        </div>
      )}

      {list.map((p) => (
        <ProjectCard key={p.id} project={p} onToast={pushSuccess} />
      ))}
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
      <div className="st-section-lbl">Google Calendar</div>
      {list.length === 0 && (
        <div className="st-empty">
          프로젝트를 먼저 추가한 뒤 각 프로젝트에서 Google Calendar를 연결하세요.
        </div>
      )}
      {list.map((p) => (
        <GoogleCalendarBlock key={p.id} projectId={p.id} onToast={pushSuccess} />
      ))}

      <div className="st-section-lbl" style={{ marginTop: 22 }}>Hermes 브리지</div>
      <HermesBridgeBlock onToast={pushSuccess} />
    </>
  );
}

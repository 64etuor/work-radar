import { ArrowLeft } from "lucide-react";

import { useProjects, useReconcileSignalProjects } from "@/lib/query";
import { useUIStore } from "@/store";
import { useToastStore } from "@/lib/toast";

import { AddProjectForm } from "./settings/AddProjectForm";
import { HermesBridgeBlock } from "./settings/HermesBridgeBlock";
import { NavigationSettings } from "./settings/NavigationSettings";
import { NotificationSettings } from "./settings/NotificationSettings";
import { ProjectCard } from "./settings/ProjectCard";

/**
 * 설정 / 프로젝트 뷰 (단일 창 내 토글). cmdk 팔레트 또는 Cmd+, 로 진입, Esc/← 로 보드 복귀.
 * Add Project / 프로젝트별 토큰(keychain)·ping·레포 관리 + signal projectId reconcile.
 */
export function SettingsView() {
  const { goTo, settingsIntent } = useUIStore();
  const projects = useProjects();
  const reconcile = useReconcileSignalProjects();
  const { pushSuccess } = useToastStore();

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
        <span className="st-title">설정 / 프로젝트</span>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={runReconcile}
          disabled={reconcile.isPending || list.length === 0}
          title="미태깅 신호를 kind→프로젝트로 reconcile"
        >
          {reconcile.isPending ? "재정렬 중…" : "신호 projectId 재정렬"}
        </button>
      </header>

      <div className="st-scroll">
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

        <div className="st-section-lbl">네비게이션 / 단축키</div>
        <NavigationSettings onToast={pushSuccess} />

        <div className="st-section-lbl">알림 / 트레이</div>
        <NotificationSettings onToast={pushSuccess} />

        <div className="st-section-lbl">Hermes 브리지</div>
        <HermesBridgeBlock onToast={pushSuccess} />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import type { ProjectKind } from "@/bindings";
import { useCreateProject } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";

/**
 * Add Project 폼 (contact-form-card 톤). 개인/업무 + Notion DB 바인딩 + ticketKeyPattern.
 * 토큰은 여기서 받지 않는다 — 프로젝트 생성 후 ProjectCard의 토큰 입력에서 keychain으로.
 */
export function AddProjectForm({
  autoFocus,
  onCreated,
}: {
  autoFocus?: boolean;
  onCreated?: (msg: string) => void;
}) {
  const create = useCreateProject();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("work");
  const [backlogDb, setBacklogDb] = useState("");
  const [agendaDb, setAgendaDb] = useState("");
  const [ticketPattern, setTicketPattern] = useState("");

  useEffect(() => {
    if (autoFocus) nameRef.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (!name.trim() || create.isPending) return;
    create.mutate(
      {
        name: name.trim(),
        kind,
        notionBacklogDbId: trimOrNull(backlogDb),
        notionAgendaDbId: trimOrNull(agendaDb),
        ticketKeyPattern: trimOrNull(ticketPattern),
      },
      {
        onSuccess: (p) => {
          setName("");
          setBacklogDb("");
          setAgendaDb("");
          setTicketPattern("");
          onCreated?.(`프로젝트 "${p.name}" 추가`);
        },
      },
    );
  };

  return (
    <div className="st-card">
      <div className="st-card-lbl">새 프로젝트</div>

      <div className="st-field">
        <label className="st-label">이름</label>
        <input
          ref={nameRef}
          className="st-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="예: Mirrorless / 내 삶"
        />
      </div>

      <div className="st-field">
        <label className="st-label">종류</label>
        <div className="st-seg">
          <button
            type="button"
            className={kind === "personal" ? "on" : ""}
            data-kind="personal"
            onClick={() => setKind("personal")}
          >
            개인
          </button>
          <button
            type="button"
            className={kind === "work" ? "on" : ""}
            data-kind="work"
            onClick={() => setKind("work")}
          >
            업무
          </button>
        </div>
      </div>

      <div className="st-field">
        <label className="st-label">Notion 백로그 DB ID</label>
        <input
          className="st-input"
          value={backlogDb}
          onChange={(e) => setBacklogDb(e.target.value)}
          placeholder="(선택) 백로그 데이터베이스 ID"
        />
      </div>

      <div className="st-field">
        <label className="st-label">Notion 안건 DB ID</label>
        <input
          className="st-input"
          value={agendaDb}
          onChange={(e) => setAgendaDb(e.target.value)}
          placeholder="(선택) 안건 데이터베이스 ID"
        />
      </div>

      <div className="st-field">
        <label className="st-label">티켓 키 패턴</label>
        <input
          className="st-input"
          value={ticketPattern}
          onChange={(e) => setTicketPattern(e.target.value)}
          placeholder="예: MIR-DEV-\d+ (조인 키)"
        />
      </div>

      {create.isError && <div className="st-err">{String(create.error)}</div>}

      <div className="st-actions">
        <button
          type="button"
          className="st-btn"
          onClick={submit}
          disabled={!name.trim() || create.isPending}
        >
          {create.isPending ? "추가 중…" : "프로젝트 추가"}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileText, Plus, Save, Trash2, Wrench } from "lucide-react";

import type { Skill } from "@/bindings";
import {
  useCreateSkill,
  useDeleteSkill,
  useExternalSkillContent,
  useSkills,
  useUpdateSkill,
  useWriteExternalSkill,
} from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * 스킬 공유 레지스트리 뷰 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
 * Claude/Codex 스킬(~/.claude/skills)을 한 곳에서 보기/편집/추가/토글한다.
 *
 * INVARIANT #1/#2: 프롬프트 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡은 여전히 제안 레일 +
 * Acceptance 게이트(awaiting_approval)를 거치고 accept는 suggested 필드/proposal만 쓴다 — 스킬을
 * 편집해도 자동 분류/자동 적용 경로는 절대 생기지 않는다. 외부 스킬 파일은 실행하지 않는다(읽기/편집).
 */
export function SkillsView() {
  const { goTo } = useUIStore();
  const skills = useSkills();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = skills.data ?? [];
  const inApp = useMemo(
    () => list.filter((s) => s.kind === "in_app_prompt"),
    [list],
  );
  const external = useMemo(
    () => list.filter((s) => s.kind === "external"),
    [list],
  );

  const selected = list.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="skl">
      <header className="skl-head" data-tauri-drag-region>
        <button type="button" className="skl-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="skl-title">스킬 레지스트리</span>
        <button
          type="button"
          className="skl-add"
          onClick={() => {
            setAdding(true);
            setSelectedId(null);
          }}
        >
          <Plus className="size-4" />
          인앱 프롬프트 추가
        </button>
      </header>

      <div className="skl-body">
        <aside className="skl-list">
          {skills.isError && (
            <div className="skl-note err">
              레지스트리를 불러오지 못했습니다: {(skills.error as Error).message}
            </div>
          )}
          <div className="skl-group-label">인앱 프롬프트 (잡 바인딩)</div>
          {inApp.length === 0 && (
            <div className="skl-empty-sm">인앱 프롬프트가 없습니다.</div>
          )}
          {inApp.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              active={s.id === selectedId}
              onSelect={() => {
                setSelectedId(s.id);
                setAdding(false);
              }}
            />
          ))}

          <div className="skl-group-label">외부 스킬 (~/.claude/skills)</div>
          {external.length === 0 && (
            <div className="skl-empty-sm">
              ~/.claude/skills에서 스킬을 찾지 못했습니다.
            </div>
          )}
          {external.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              active={s.id === selectedId}
              onSelect={() => {
                setSelectedId(s.id);
                setAdding(false);
              }}
            />
          ))}
        </aside>

        <section className="skl-detail">
          {adding ? (
            <CreatePanel
              onDone={(id) => {
                setAdding(false);
                if (id) setSelectedId(id);
              }}
            />
          ) : selected?.kind === "in_app_prompt" ? (
            <InAppEditor key={selected.id} skill={selected} />
          ) : selected?.kind === "external" ? (
            <ExternalViewer key={selected.id} skill={selected} />
          ) : (
            <div className="skl-empty">
              왼쪽에서 스킬을 선택해 보기/편집하거나, 인앱 프롬프트를 추가하세요.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** 목록의 한 줄(인앱/외부 공통). 인앱은 binding·enabled 배지, 외부는 경로 표시. */
function SkillRow({
  skill,
  active,
  onSelect,
}: {
  skill: Skill;
  active: boolean;
  onSelect: () => void;
}) {
  const isInApp = skill.kind === "in_app_prompt";
  return (
    <button
      type="button"
      className={`skl-row${active ? " active" : ""}`}
      onClick={onSelect}
    >
      {isInApp ? (
        <Wrench className="size-4 skl-row-ico" />
      ) : (
        <FileText className="size-4 skl-row-ico" />
      )}
      <span className="skl-row-main">
        <span className="skl-row-name">{skill.name}</span>
        {isInApp && skill.binding && (
          <span className="skl-row-bind">{skill.binding}</span>
        )}
      </span>
      {isInApp && !skill.enabled && <span className="skl-row-off">꺼짐</span>}
    </button>
  );
}

/** 인앱 프롬프트 편집기: 이름 + 텍스트에어리어(템플릿) + enable 토글 + 저장/삭제. */
function InAppEditor({ skill }: { skill: Skill }) {
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const [prompt, setPrompt] = useState(skill.prompt ?? "");
  const [name, setName] = useState(skill.name);
  const [note, setNote] = useState<string | null>(null);

  // 다른 스킬로 전환 시 폼 동기화(key로 재마운트하지만 안전망).
  useEffect(() => {
    setPrompt(skill.prompt ?? "");
    setName(skill.name);
  }, [skill.id, skill.prompt, skill.name]);

  const dirty = prompt !== (skill.prompt ?? "") || name !== skill.name;

  const save = () => {
    if (update.isPending) return;
    setNote(null);
    update.mutate(
      { id: skill.id, prompt, name },
      {
        onSuccess: () => setNote("저장됨"),
        onError: (e) => setNote(`저장 실패: ${(e as Error).message}`),
      },
    );
  };

  const toggle = () => {
    if (update.isPending) return;
    update.mutate(
      { id: skill.id, enabled: !skill.enabled },
      {
        onError: (e) => setNote(`토글 실패: ${(e as Error).message}`),
      },
    );
  };

  const remove = () => {
    if (del.isPending) return;
    if (!confirm(`'${skill.name}' 인앱 프롬프트를 삭제할까요? (잡은 기본 프롬프트로 돌아갑니다)`))
      return;
    del.mutate(skill.id, {
      onError: (e) => setNote(`삭제 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <input
          className="skl-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="스킬 이름"
        />
        <label className="skl-toggle">
          <input type="checkbox" checked={skill.enabled} onChange={toggle} />
          <span>활성</span>
        </label>
      </div>

      {skill.binding && (
        <div className="skl-bind-line">
          잡 바인딩: <code>{skill.binding}</code> · 끄거나 비우면 잡이 기본 프롬프트를
          사용합니다.
        </div>
      )}

      <textarea
        className="skl-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        aria-label="프롬프트 템플릿"
      />

      <div className="skl-actions">
        <button
          type="button"
          className="skl-save"
          onClick={save}
          disabled={!dirty || update.isPending}
        >
          <Save className="size-4" />
          {update.isPending ? "저장 중…" : "저장"}
        </button>
        <button
          type="button"
          className="skl-del"
          onClick={remove}
          disabled={del.isPending}
        >
          <Trash2 className="size-4" />
          삭제
        </button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

/** 외부 스킬 뷰어(SKILL.md 내용). 사용자 명시 편집 가능(자기 파일). 실행은 절대 없음. */
function ExternalViewer({ skill }: { skill: Skill }) {
  const path = skill.sourcePath ?? null;
  const content = useExternalSkillContent(path);
  const write = useWriteExternalSkill();

  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const body = content.data ?? "";
  const dirty = editing && draft !== null && draft !== body;

  const startEdit = () => {
    setDraft(body);
    setEditing(true);
    setNote(null);
  };

  const save = () => {
    if (!path || draft === null || write.isPending) return;
    write.mutate(
      { path, content: draft },
      {
        onSuccess: () => {
          setNote("파일 저장됨");
          setEditing(false);
        },
        onError: (e) => setNote(`저장 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <span className="skl-name-static">{skill.name}</span>
        {!editing ? (
          <button type="button" className="skl-save" onClick={startEdit}>
            파일 편집
          </button>
        ) : (
          <button
            type="button"
            className="skl-save"
            onClick={save}
            disabled={!dirty || write.isPending}
          >
            <Save className="size-4" />
            {write.isPending ? "저장 중…" : "파일 저장"}
          </button>
        )}
      </div>

      <div className="skl-bind-line skl-path">{path}</div>
      {skill.prompt && <div className="skl-desc">{skill.prompt}</div>}

      {content.isLoading ? (
        <div className="skl-empty-sm">불러오는 중…</div>
      ) : content.isError ? (
        <div className="skl-note err">
          파일을 읽지 못했습니다: {(content.error as Error).message}
        </div>
      ) : editing ? (
        <textarea
          className="skl-textarea"
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label="외부 스킬 파일"
        />
      ) : (
        <pre className="skl-pre">{body}</pre>
      )}

      {note && <div className="skl-note">{note}</div>}
    </div>
  );
}

/** 인앱 프롬프트 추가 패널. binding은 닫힌 세트(또는 미바인딩). */
function CreatePanel({ onDone }: { onDone: (id: string | null) => void }) {
  const create = useCreateSkill();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [binding, setBinding] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);

  const submit = () => {
    if (create.isPending) return;
    setNote(null);
    create.mutate(
      { name, prompt, binding: binding || null },
      {
        onSuccess: (s) => onDone(s.id),
        onError: (e) => setNote(`추가 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <input
          className="skl-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="스킬 이름"
          aria-label="새 스킬 이름"
        />
        <select
          className="skl-bind-select"
          value={binding}
          onChange={(e) => setBinding(e.target.value)}
          aria-label="잡 바인딩"
        >
          <option value="">미바인딩</option>
          <option value="enrich">enrich</option>
          <option value="batch_enrich">batch_enrich</option>
          <option value="ci_triage">ci_triage</option>
          <option value="pr_selfcheck">pr_selfcheck</option>
        </select>
      </div>
      <textarea
        className="skl-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="프롬프트 템플릿…"
        spellCheck={false}
        aria-label="새 프롬프트 템플릿"
      />
      <div className="skl-actions">
        <button
          type="button"
          className="skl-save"
          onClick={submit}
          disabled={!name.trim() || !prompt.trim() || create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "추가"}
        </button>
        <button type="button" className="skl-del" onClick={() => onDone(null)}>
          취소
        </button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

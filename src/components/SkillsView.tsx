import { useEffect, useMemo, useState } from "react";
import "./SkillsView.css";
import { Blocks, FileText, Plus, Save, Search, Trash2 } from "lucide-react";

import type { Skill } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
  const { pendingSkillId, clearPendingSkill } = useUIStore();
  const skills = useSkills();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  // 팔레트에서 스킬을 고르면 그 스킬을 선택(보기/편집)한다 — 한 번만 소비.
  // 동일 선택 핸들러(selectedId) 경로라 자동 실행은 없다(INVARIANT #1).
  useEffect(() => {
    if (!pendingSkillId) return;
    setSelectedId(pendingSkillId);
    setAdding(false);
    clearPendingSkill();
  }, [pendingSkillId, clearPendingSkill]);

  const list = useMemo(() => skills.data ?? [], [skills.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.binding, s.sourcePath, s.kind]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [list, search]);
  const segments = useMemo(() => segmentSkills(filtered), [filtered]);

  const selected = list.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="skl">
      <header className="skl-head" data-tauri-drag-region>
        <span className="skl-title">스킬 레지스트리</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5 rounded-full"
          onClick={() => {
            setAdding(true);
            setSelectedId(null);
          }}
        >
          <Plus className="size-4" />
          인앱 프롬프트 추가
        </Button>
      </header>

      <div className="skl-body">
        <aside className="skl-list">
          <div className="skl-search">
            <Search className="size-3.5" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="스킬 검색"
              aria-label="스킬 검색"
            />
          </div>
          {skills.isError && (
            <div className="skl-note err">
              레지스트리를 불러오지 못했습니다: {(skills.error as Error).message}
            </div>
          )}
          {segments.map((segment) => (
            <div key={segment.key}>
              <div className="skl-group-label">
                {segment.label}
                <span>{segment.health}</span>
              </div>
              {segment.skills.length === 0 && (
                <div className="skl-empty-sm">해당 스킬이 없습니다.</div>
              )}
              {segment.skills.map((s) => (
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
            </div>
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

function providerOf(skill: Skill): "codex" | "claude" | "other" | "project" {
  if (skill.kind === "in_app_prompt") return "project";
  const path = (skill.sourcePath ?? "").toLowerCase();
  if (path.includes(".codex")) return "codex";
  if (path.includes(".claude")) return "claude";
  return "other";
}

function segmentSkills(skills: Skill[]) {
  const defs = [
    { key: "global", label: "Global Skills", match: (s: Skill) => s.kind === "in_app_prompt" && !s.binding },
    { key: "external-codex", label: "External Skills · Codex", match: (s: Skill) => providerOf(s) === "codex" },
    { key: "external-claude", label: "External Skills · Claude", match: (s: Skill) => providerOf(s) === "claude" },
    { key: "external-other", label: "External Skills · Other", match: (s: Skill) => providerOf(s) === "other" },
    { key: "project", label: "Project Skills", match: (s: Skill) => s.kind === "in_app_prompt" && !!s.binding },
  ];
  return defs.map((def) => {
    const group = skills.filter(def.match);
    return {
      key: def.key,
      label: def.label,
      health: `${group.filter((s) => s.enabled).length}/${group.length}`,
      skills: group.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
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
        <Blocks className="size-4 skl-row-ico" />
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
        <Input
          className="flex-1 font-semibold"
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

      <Textarea
        className="min-h-[320px] resize-y font-mono leading-relaxed"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        aria-label="프롬프트 템플릿"
      />

      <div className="skl-actions">
        <Button
          className="gap-1.5 rounded-full"
          onClick={save}
          disabled={!dirty || update.isPending}
        >
          <Save className="size-4" />
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
        <Button
          variant="outline"
          className="gap-1.5 rounded-full"
          onClick={remove}
          disabled={del.isPending}
        >
          <Trash2 className="size-4" />
          삭제
        </Button>
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
          <Button className="rounded-full" onClick={startEdit}>
            파일 편집
          </Button>
        ) : (
          <Button
            className="gap-1.5 rounded-full"
            onClick={save}
            disabled={!dirty || write.isPending}
          >
            <Save className="size-4" />
            {write.isPending ? "저장 중…" : "파일 저장"}
          </Button>
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
        <Textarea
          className="min-h-[320px] resize-y font-mono leading-relaxed"
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

/** radix Select는 빈 문자열 value를 금지 → "미바인딩"을 센티넬로 표현(write 시 빈 문자열로 정규화). */
const BIND_NONE = "__none__";

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
        <Input
          className="flex-1 font-semibold"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="스킬 이름"
          aria-label="새 스킬 이름"
        />
        <Select
          value={binding || BIND_NONE}
          onValueChange={(v) => setBinding(v === BIND_NONE ? "" : v)}
        >
          <SelectTrigger className="w-auto min-w-[140px] font-mono" aria-label="잡 바인딩">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BIND_NONE}>미바인딩</SelectItem>
            <SelectItem value="enrich">enrich</SelectItem>
            <SelectItem value="batch_enrich">batch_enrich</SelectItem>
            <SelectItem value="ci_triage">ci_triage</SelectItem>
            <SelectItem value="pr_selfcheck">pr_selfcheck</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        className="min-h-[320px] resize-y font-mono leading-relaxed"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="프롬프트 템플릿…"
        spellCheck={false}
        aria-label="새 프롬프트 템플릿"
      />
      <div className="skl-actions">
        <Button
          className="gap-1.5 rounded-full"
          onClick={submit}
          disabled={!name.trim() || !prompt.trim() || create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "추가"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

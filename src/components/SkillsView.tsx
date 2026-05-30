import "./SkillsView.css";
import "./SkillsTags.css";

import {
  Blocks,
  CircleHelp,
  FileText,
  LayoutGrid,
  List,
  Plus,
  Save,
  Search,
  Tag,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Skill } from "@/bindings";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { SkillsHelpDialog } from "@/components/SkillsHelpDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateSkill,
  useDeleteSkill,
  useExternalSkillContent,
  useSetSkillTags,
  useSkillEnvironments,
  useSkills,
  useUpdateSkill,
  useWriteExternalSkill,
} from "@/lib/query";
import { skillCardBadges } from "@/lib/skillBadges";
import {
  addTagToSkill,
  batchMutableTargets,
  batchTaggableTargets,
  selectedSkills,
} from "@/lib/skillBatch";
import {
  applyEnvOrder,
  buildSkillEnvNav,
  envCounts,
  reorderEnv,
  type SkillEnvNavItem,
} from "@/lib/skillEnvNav";
import { collectTags, matchesTag, UNTAGGED } from "@/lib/skillTags";
import { useStickyToggle } from "@/lib/useStickyToggle";
import { useUIStore } from "@/store";

const ENV_ORDER_KEY = "wr:skills:env-order";

/** 환경 사이드바 표시 순서(id 배열)를 localStorage에 유지. 외부 상태 불변(#14 로컬 표시 순서). */
function loadEnvOrder(): string[] {
  try {
    const raw = localStorage.getItem(ENV_ORDER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 스킬 공유 레지스트리 뷰 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
 * Claude/Codex 스킬(~/.claude/skills)을 한 곳에서 보기/편집/추가/토글한다.
 *
 * 레이아웃은 skills-manager(오픈소스)에서 차용: 헤더(검색·grid/list 토글·추가) + 카드 그리드 +
 * 슬라이드오버 Sheet(편집기/뷰어). 데이터 모델·커맨드·레일은 무변경(표현만 교체).
 *
 * INVARIANT #1/#2: 프롬프트 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡은 여전히 제안 레일 +
 * Acceptance 게이트(awaiting_approval)를 거치고 accept는 suggested 필드/proposal만 쓴다 — 스킬을
 * 편집해도 자동 분류/자동 적용 경로는 절대 생기지 않는다. 외부 스킬 파일은 실행하지 않는다(읽기/편집).
 */
export function SkillsView() {
  const { pendingSkillId, clearPendingSkill } = useUIStore();
  const skills = useSkills();
  const environments = useSkillEnvironments();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [listView, setListView] = useStickyToggle("wr:skills:list-view");
  // 도움말 다이얼로그 열림 — 스킬 피처 로컬 상태(전역 store 비대상).
  const [helpOpen, setHelpOpen] = useState(false);
  // 태그 필터(#12): null=전체, UNTAGGED=태그 없음, 그 외=해당 태그. 로컬 표시 상태(외부 불변).
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // 다중 선택(#9): 선택된 통합 Skill.id 집합 + 배치 태그 입력. 외부 스킬은 토글/삭제 비대상(skillBatch).
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchTag, setBatchTag] = useState("");
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const batchUpdate = useUpdateSkill();
  const batchDelete = useDeleteSkill();
  const batchSetTags = useSetSkillTags();

  // 환경 사이드바: 활성 환경(필터) + 로컬 표시 순서(드래그 재정렬) + 진행 중 드래그 id.
  const [activeEnvId, setActiveEnvId] = useState<string>("all");
  const [envOrder, setEnvOrderState] = useState<string[]>(loadEnvOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const setEnvOrder = (next: string[]) => {
    setEnvOrderState(next);
    try {
      localStorage.setItem(ENV_ORDER_KEY, JSON.stringify(next));
    } catch {
      /* private mode 등 — 무시 */
    }
  };

  // 팔레트에서 스킬을 고르면 그 스킬을 선택(보기/편집)한다 — 한 번만 소비.
  // 동일 선택 핸들러(selectedId) 경로라 자동 실행은 없다(INVARIANT #1).
  // setState는 prev-compare로 render에서 적용 (set-state-in-effect 회피),
  // store clear는 진짜 side-effect라 effect 유지.
  const [prevPending, setPrevPending] = useState(pendingSkillId);
  if (pendingSkillId !== prevPending) {
    setPrevPending(pendingSkillId);
    if (pendingSkillId) {
      setSelectedId(pendingSkillId);
      setAdding(false);
    }
  }
  useEffect(() => {
    if (pendingSkillId) clearPendingSkill();
  }, [pendingSkillId, clearPendingSkill]);

  const list = useMemo(() => skills.data ?? [], [skills.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.binding, s.sourcePath, s.kind].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [list, search]);

  // 사이드바 항목은 전체 목록(검색 무관)에서 빌드해 검색 중에도 환경이 사라지지 않게 한다.
  // 카운트/본문은 검색 적용된 filtered를 쓴다.
  const envNav = useMemo(
    () => applyEnvOrder(buildSkillEnvNav(list, environments.data), envOrder),
    [list, environments.data, envOrder],
  );
  const activeEnv = envNav.find((i) => i.id === activeEnvId) ?? envNav[0];
  const envFiltered = useMemo(
    () => (activeEnv ? filtered.filter(activeEnv.match) : filtered),
    [filtered, activeEnv],
  );
  // 태그 필터(#12): pill 소스는 전체 목록(검색/환경 무관)에서 모아 안정적으로 유지하고, 본문은
  // 환경+태그를 모두 적용한 결과를 쓴다. 활성 태그가 더 이상 존재하지 않으면 자동으로 전체로 복귀.
  const allTags = useMemo(() => collectTags(list), [list]);
  if (activeTag !== null && activeTag !== UNTAGGED && !allTags.includes(activeTag)) {
    setActiveTag(null);
  }
  const tagFiltered = useMemo(
    () => envFiltered.filter((s) => matchesTag(s, activeTag)),
    [envFiltered, activeTag],
  );
  const segments = useMemo(() => segmentSkills(tagFiltered), [tagFiltered]);
  const total = tagFiltered.length;

  const onEnvDrop = (targetId: string) => {
    if (!dragId) return;
    const movableIds = envNav.filter((i) => !i.pinned).map((i) => i.id);
    setEnvOrder(reorderEnv(movableIds, dragId, targetId));
    setDragId(null);
  };

  const selected = list.find((s) => s.id === selectedId) ?? null;
  const sheetOpen = adding || !!selected;
  const closeSheet = () => {
    setAdding(false);
    setSelectedId(null);
  };

  // 다중 선택(#9): 토글/삭제는 인앱만(외부 제외), 태깅은 선택 전체(외부=로컬 SQLite만). skillBatch가 정본.
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => {
    setSelectedIds(new Set());
    setBatchNote(null);
  };
  const selCount = selectedSkills(list, selectedIds).length;
  const mutableTargets = batchMutableTargets(list, selectedIds);
  const taggableTargets = batchTaggableTargets(list, selectedIds);
  const batchBusy = batchUpdate.isPending || batchDelete.isPending || batchSetTags.isPending;

  // 배치 결과 정리: 성공한 항목만 선택 해제하고(실패는 재시도 가능하게 선택 유지), 실패 수를 노출한다.
  // 무효화(onSuccess)가 진실을 다시 가져오므로 부분 실패해도 표시는 일관된다.
  const finishBatch = (targets: Skill[], results: PromiseSettledResult<unknown>[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      targets.forEach((t, i) => {
        if (results[i]?.status === "fulfilled") next.delete(t.id);
      });
      return next;
    });
    const failed = results.filter((r) => r.status === "rejected").length;
    setBatchNote(failed > 0 ? `${failed}개 실패 — 다시 시도하세요` : null);
  };

  const batchToggle = (enabled: boolean) => {
    if (batchBusy) return;
    setBatchNote(null);
    const targets = mutableTargets;
    Promise.allSettled(targets.map((s) => batchUpdate.mutateAsync({ id: s.id, enabled }))).then(
      (results) => finishBatch(targets, results),
    );
  };
  const batchAddTag = () => {
    const t = batchTag.trim();
    if (!t || batchBusy) return;
    setBatchTag("");
    setBatchNote(null);
    const targets = taggableTargets;
    Promise.allSettled(
      targets.map((s) => batchSetTags.mutateAsync({ skillKey: s.id, tags: addTagToSkill(s, t) })),
    ).then((results) => finishBatch(targets, results));
  };
  const batchRemove = () => {
    if (batchBusy || mutableTargets.length === 0) return;
    if (
      !window.confirm(
        `선택한 인앱 프롬프트 ${mutableTargets.length}개를 삭제할까요? (외부 스킬은 제외)`,
      )
    )
      return;
    setBatchNote(null);
    const targets = mutableTargets;
    Promise.allSettled(targets.map((s) => batchDelete.mutateAsync(s.id))).then((results) =>
      finishBatch(targets, results),
    );
  };

  return (
    <div className="skl">
      <header className="skl-head" data-tauri-drag-region>
        <span className="skl-title">스킬 레지스트리</span>
        <span className="skl-count">{total}</span>
      </header>

      {/* 상호작용 컨트롤은 drag-region 밖 별도 툴바에(InboxView 선례) — 드래그가 입력/클릭을 삼키지 않도록. */}
      <div className="skl-toolbar">
        <div className="skl-search">
          <Search className="size-3.5" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="스킬 검색"
            aria-label="스킬 검색"
          />
        </div>

        <div className="skl-viewtoggle" role="group" aria-label="보기 전환">
          <Button
            variant={listView ? "outline" : "default"}
            size="sm"
            className="rounded-full px-2.5"
            aria-pressed={!listView}
            aria-label="그리드 보기"
            onClick={() => setListView(false)}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Button
            variant={listView ? "default" : "outline"}
            size="sm"
            className="rounded-full px-2.5"
            aria-pressed={listView}
            aria-label="리스트 보기"
            onClick={() => setListView(true)}
          >
            <List className="size-4" />
          </Button>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-2.5"
          aria-label="도움말"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp className="size-4" />
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => {
            setAdding(true);
            setSelectedId(null);
          }}
        >
          <Plus className="size-4" />
          인앱 프롬프트 추가
        </Button>
      </div>

      {allTags.length > 0 && (
        <div className="skl-tagbar" role="group" aria-label="태그 필터">
          <button
            type="button"
            className={cn("skl-tagpill", activeTag === null && "active")}
            aria-pressed={activeTag === null}
            onClick={() => setActiveTag(null)}
          >
            전체
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              className={cn("skl-tagpill", activeTag === t && "active")}
              aria-pressed={activeTag === t}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            className={cn("skl-tagpill", activeTag === UNTAGGED && "active")}
            aria-pressed={activeTag === UNTAGGED}
            onClick={() => setActiveTag(activeTag === UNTAGGED ? null : UNTAGGED)}
          >
            태그 없음
          </button>
        </div>
      )}

      {selCount > 0 && (
        <div className="skl-batchbar" role="toolbar" aria-label="선택 작업">
          <span className="skl-batch-count">
            {selCount}개 선택
            {mutableTargets.length < selCount && (
              <span className="skl-batch-note"> · 인앱 {mutableTargets.length}</span>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 rounded-full"
            disabled={mutableTargets.length === 0 || batchBusy}
            onClick={() => batchToggle(true)}
          >
            <ToggleRight className="size-4" />
            모두 켜기
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 rounded-full"
            disabled={mutableTargets.length === 0 || batchBusy}
            onClick={() => batchToggle(false)}
          >
            <ToggleLeft className="size-4" />
            모두 끄기
          </Button>
          <div className="skl-batch-tag">
            <Tag className="size-3.5" />
            <input
              value={batchTag}
              onChange={(e) => setBatchTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  batchAddTag();
                }
              }}
              placeholder="태그 추가"
              aria-label="선택 항목에 태그 추가"
            />
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={!batchTag.trim() || batchBusy}
              onClick={batchAddTag}
            >
              추가
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 rounded-full"
            disabled={mutableTargets.length === 0 || batchBusy}
            onClick={batchRemove}
          >
            <Trash2 className="size-4" />
            삭제
          </Button>
          {batchNote && <span className="skl-note err skl-batch-note-err">{batchNote}</span>}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 rounded-full"
            onClick={clearSelection}
          >
            <X className="size-4" />
            선택 해제
          </Button>
        </div>
      )}

      <div className="skl-main">
        <nav className="skl-sidebar" aria-label="스킬 환경">
          {envNav.map((item) => (
            <EnvNavButton
              key={item.id}
              item={item}
              count={envCounts(item, filtered)}
              active={(activeEnv?.id ?? "all") === item.id}
              onSelect={() => setActiveEnvId(item.id)}
              onDragStart={() => setDragId(item.id)}
              onDropItem={() => onEnvDrop(item.id)}
            />
          ))}
        </nav>

        <div className="skl-body">
          {skills.isError && (
            <div className="skl-note err">
              레지스트리를 불러오지 못했습니다: {(skills.error as Error).message}
            </div>
          )}
          {!skills.isError && total === 0 && (
            <div className="skl-empty">
              {search.trim()
                ? "검색 결과가 없습니다."
                : "이 환경에 스킬이 없습니다. 인앱 프롬프트를 추가하거나 ~/.claude/skills에 스킬을 두세요."}
            </div>
          )}
          {segments.map((segment) => (
            <section key={segment.key} className="skl-section">
              <div className="skl-group-label">
                {segment.label}
                <span>{segment.health}</span>
              </div>
              <div className={cn("skl-cards", listView ? "list" : "grid")}>
                {segment.skills.map((s) => (
                  <div
                    key={s.id}
                    className={cn("skl-card-wrap", selectedIds.has(s.id) && "selected")}
                  >
                    <input
                      type="checkbox"
                      className="skl-card-check"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleSelect(s.id)}
                      aria-label={`${s.name} 선택`}
                    />
                    <SkillCard
                      skill={s}
                      listView={listView}
                      active={s.id === selectedId}
                      onSelect={() => {
                        setSelectedId(s.id);
                        setAdding(false);
                      }}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={(o) => !o && closeSheet()}>
        {sheetOpen && (
          <SheetContent className="skl-sheet">
            <SheetTitle className="skl-sheet-kind">
              {adding
                ? "인앱 프롬프트 추가"
                : selected?.kind === "external"
                  ? "외부 스킬"
                  : "인앱 프롬프트"}
            </SheetTitle>
            <div className="skl-sheet-body">
              {adding ? (
                <CreatePanel
                  onDone={(id) => {
                    setAdding(false);
                    if (id) setSelectedId(id);
                    else closeSheet();
                  }}
                />
              ) : selected?.kind === "in_app_prompt" ? (
                <InAppEditor key={selected.id} skill={selected} />
              ) : selected?.kind === "external" ? (
                <ExternalViewer key={selected.id} skill={selected} />
              ) : null}
            </div>
          </SheetContent>
        )}
      </Sheet>

      <SkillsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** 본문 카드 섹션 분류. 외부 스킬 귀속은 백엔드 `Skill.provider`(P0)를 직접 쓴다 — 경로추론(구
 * `providerOf`) 폐기. in-app은 binding 유무로 Global/Project를 나눈다(provider=null). */
function segmentSkills(skills: Skill[]) {
  const defs = [
    {
      key: "global",
      label: "Global Skills",
      match: (s: Skill) => s.kind === "in_app_prompt" && !s.binding,
    },
    {
      key: "project",
      label: "Project Skills",
      match: (s: Skill) => s.kind === "in_app_prompt" && !!s.binding,
    },
    {
      key: "external-claude",
      label: "External Skills · Claude",
      match: (s: Skill) => s.provider === "claude",
    },
    {
      key: "external-codex",
      label: "External Skills · Codex",
      match: (s: Skill) => s.provider === "codex",
    },
    {
      key: "external-openclaw",
      label: "External Skills · OpenClaw",
      match: (s: Skill) => s.provider === "openclaw",
    },
    {
      key: "external-hermes",
      label: "External Skills · Hermes",
      match: (s: Skill) => s.provider === "hermes",
    },
    {
      key: "external-other",
      label: "External Skills · Other",
      match: (s: Skill) => s.provider === "other",
    },
  ];
  return defs
    .map((def) => {
      const group = skills.filter(def.match);
      return {
        key: def.key,
        label: def.label,
        health: `${group.filter((s) => s.enabled).length}/${group.length}`,
        skills: group.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .filter((seg) => seg.skills.length > 0);
}

/** 좌측 환경 사이드바 한 항목(필터 버튼 + enabled/total 배지). "전체"를 제외하면 드래그로 재정렬 가능
 * (로컬 표시 순서 — 외부 상태 불변, #14). */
function EnvNavButton({
  item,
  count,
  active,
  onSelect,
  onDragStart,
  onDropItem,
}: {
  item: SkillEnvNavItem;
  count: { enabled: number; total: number };
  active: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDropItem: () => void;
}) {
  const draggable = !item.pinned;
  return (
    <button
      type="button"
      className={cn("skl-env", active && "active")}
      aria-pressed={active}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDropItem();
            }
          : undefined
      }
    >
      <span className="skl-env-label">{item.label}</span>
      <span className="skl-env-count">
        {count.enabled}/{count.total}
      </span>
    </button>
  );
}

/** /Users/<me> 접두를 ~로 축약(외부 스킬 경로 표시용). */
function compactPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** 레지스트리 카드(인앱/외부 공통). 클릭하면 Sheet로 보기/편집. grid/list 두 변형. */
function SkillCard({
  skill,
  listView,
  active,
  onSelect,
}: {
  skill: Skill;
  listView: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const isInApp = skill.kind === "in_app_prompt";
  const Icon = isInApp ? Blocks : FileText;
  const desc = (skill.prompt ?? "").trim();
  const sub = isInApp ? skill.binding : skill.sourcePath ? compactPath(skill.sourcePath) : null;
  const badges = skillCardBadges(skill);

  return (
    <button
      type="button"
      className={cn("skl-card", listView ? "list" : "grid", active && "active")}
      onClick={onSelect}
    >
      <span className="skl-card-top">
        <Icon className="skl-card-ico size-4" />
        <span className="skl-card-name">{skill.name}</span>
        <span className="skl-card-badges">
          {badges.map((b) => (
            <span key={b.key} className={cn("skl-badge", `skl-badge-${b.tone}`)}>
              {b.label}
            </span>
          ))}
        </span>
      </span>
      {sub && <span className="skl-card-sub">{sub}</span>}
      {desc && <span className="skl-card-desc">{desc}</span>}
      {skill.tags.length > 0 && (
        <span className="skl-card-tags">
          {skill.tags.map((t) => (
            <span key={t} className="skl-card-tag">
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** 스킬 태그 편집기(인앱/외부 공통 — Sheet 안). 칩 클릭=제거, 입력+Enter=추가. set 의미로 전체 교체.
 * 외부 스킬도 태그 가능(로컬 SQLite만 — 디스크 파일 무변경). 사람 태깅 전용(#1 — 자동 분류 없음). */
function SkillTagsEditor({ skill }: { skill: Skill }) {
  const setTags = useSetSkillTags();
  const [input, setInput] = useState("");
  const tags = skill.tags;

  const commit = (next: string[]) => {
    if (setTags.isPending) return;
    setTags.mutate({ skillKey: skill.id, tags: next });
  };
  const add = () => {
    const t = input.trim();
    setInput("");
    if (!t || tags.includes(t)) return;
    commit([...tags, t]);
  };
  const remove = (t: string) => commit(tags.filter((x) => x !== t));

  return (
    <div className="skl-tags-edit">
      <span className="skl-tags-label">태그</span>
      <div className="skl-tags-chips">
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            className="skl-tag-chip"
            onClick={() => remove(t)}
            aria-label={`태그 ${t} 제거`}
          >
            {t}
            <X className="size-3" />
          </button>
        ))}
        <input
          className="skl-tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="태그 추가"
          aria-label="태그 추가"
        />
      </div>
    </div>
  );
}

/** 인앱 프롬프트 편집기: 이름 + 텍스트에어리어(템플릿) + enable 토글 + 저장/삭제. */
function InAppEditor({ skill }: { skill: Skill }) {
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const [prompt, setPrompt] = useState(skill.prompt ?? "");
  const [name, setName] = useState(skill.name);
  const [note, setNote] = useState<string | null>(null);

  // 다른 스킬로 전환 시 폼 동기화 — prev-compare로 render에서 적용 (set-state-in-effect 회피).
  // (key 재마운트가 1차 — 이건 안전망.)
  const [seededId, setSeededId] = useState(skill.id);
  if (skill.id !== seededId) {
    setSeededId(skill.id);
    setPrompt(skill.prompt ?? "");
    setName(skill.name);
  }

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
          <input type="checkbox" aria-label="스킬 활성" checked={skill.enabled} onChange={toggle} />
          <span>활성</span>
        </label>
      </div>

      {skill.binding && (
        <div className="skl-bind-line">
          잡 바인딩: <code>{skill.binding}</code> · 끄거나 비우면 잡이 기본 프롬프트를 사용합니다.
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

      <SkillTagsEditor skill={skill} />
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

      <SkillTagsEditor skill={skill} />

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
        <SkillMarkdown body={body} />
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

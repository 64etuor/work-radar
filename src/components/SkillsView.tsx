import "./SkillsView.css";
import "./SkillsTags.css";

import {
  Archive,
  Blocks,
  CircleHelp,
  Download,
  FileText,
  FolderInput,
  GitCompare,
  LayoutGrid,
  Library,
  Link2,
  List,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Tag,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Skill, SkillProvider, SkillRef } from "@/bindings";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { SkillsHelpDialog } from "@/components/SkillsHelpDialog";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type DiffLine, diffStats, lineDiff } from "@/lib/lineDiff";
import {
  useAppliedSkills,
  useApplyManagedSkill,
  useApplyManagedSkills,
  useApplySkillUpdate,
  useBackupSkillLibrary,
  useCheckSkillUpdates,
  useCreateSkill,
  useDeleteSkill,
  useExternalSkillContent,
  useImportExternalSkill,
  useInstallSkillFromGit,
  useRemoveManagedSkill,
  useRestoreSkillLibrary,
  useSetSkillAutoUpdate,
  useSetSkillTags,
  useSetSkillUpdateOnLaunch,
  useSkillBackups,
  useSkillEnvironments,
  useSkills,
  useSkillUpdateOnLaunch,
  useSkillUpdateStatus,
  useSkillWorkspaces,
  useUnapplyManagedSkill,
  useUnapplyManagedSkills,
  useUpdateSkill,
  useWriteExternalSkill,
} from "@/lib/query";
import { providerLabel, skillCardBadges } from "@/lib/skillBadges";
import {
  addTagToSkill,
  batchApplyTargets,
  batchMutableTargets,
  batchTaggableTargets,
  selectedSkills,
  summarizeBatch,
} from "@/lib/skillBatch";
import {
  groupCrossToolSkills,
  type GroupedSkill,
  groupProviders,
  type SkillLocation,
} from "@/lib/skillDedup";
import {
  applyEnvOrder,
  buildSkillEnvNav,
  buildSkillWorkspaceNav,
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
  const workspaces = useSkillWorkspaces();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // URL(GitHub) 설치 패널 열림 — adding과 배타. 외부 상태 불변(파일 복사·감사, #1/#2).
  const [installing, setInstalling] = useState(false);
  // 백업/복원 패널 열림 — 다른 패널과 배타. 로컬 파일 스냅샷·감사(잡 비취급, #1/#2).
  const [backupOpen, setBackupOpen] = useState(false);
  // 업데이트 패널 열림 — 확인/토글/적용/런치설정. fetch-only·staging만(적용은 사용자 발동, #1/#2).
  const [updateOpen, setUpdateOpen] = useState(false);
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
  // 배치 노트가 오류 스타일(빨강)인지 — 기본 true(실패 메시지가 다수). 적용/해제 성공 요약만 false(중립).
  const [batchNoteErr, setBatchNoteErr] = useState(true);
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
  const workspaceNav = useMemo(() => buildSkillWorkspaceNav(workspaces.data), [workspaces.data]);
  const activeEnv = [...envNav, ...workspaceNav].find((i) => i.id === activeEnvId) ?? envNav[0];
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
  // 도구 간 동일 스킬 그룹화(#4): 외부 스킬을 이름으로 묶어 한 카드로 표시한다(해싱/IO 없음 — 스캔
  // latency 무영향). segmentSkills는 그룹 단위로 섹션을 나눈다.
  const grouped = useMemo(() => groupCrossToolSkills(tagFiltered), [tagFiltered]);
  const segments = useMemo(() => segmentSkills(grouped), [grouped]);
  const total = tagFiltered.length;

  const onEnvDrop = (targetId: string) => {
    if (!dragId) return;
    const movableIds = envNav.filter((i) => !i.pinned).map((i) => i.id);
    setEnvOrder(reorderEnv(movableIds, dragId, targetId));
    setDragId(null);
  };

  const selected = list.find((s) => s.id === selectedId) ?? null;
  // 열린 외부 스킬이 도구 간 그룹의 일원이면 그 그룹의 위치들을 모아 Sheet 상단 전환 칩을 만든다.
  // 카드와 같은 `grouped`(필터 적용본)에서 찾으므로 카드 "N곳" 배지와 전환 칩 개수가 항상 일치한다.
  // 위치 선택 = selectedId 교체(기존 보기/편집 흐름 재사용 — 자동 실행 없음).
  const selectedGroup = useMemo<SkillLocation[]>(() => {
    if (!selected || selected.kind !== "external") return [];
    const g = grouped.find((grp) => grp.memberIds.includes(selected.id));
    return g && g.locations.length > 1 ? g.locations : [];
  }, [grouped, selected]);
  const sheetOpen = adding || installing || backupOpen || updateOpen || !!selected;
  const closeSheet = () => {
    setAdding(false);
    setInstalling(false);
    setBackupOpen(false);
    setUpdateOpen(false);
    setSelectedId(null);
  };

  // 다중 선택(#9): 토글/삭제는 인앱만(외부 제외), 태깅은 선택 전체(외부=로컬 SQLite만). skillBatch가 정본.
  // 그룹 카드 체크박스(#4): 멤버 전체를 한 번에 켜고/끈다. 모두 선택돼 있으면 해제, 아니면 전체 선택.
  // 배치 로직(selectedIds → list)은 그대로 — 외부 멤버는 토글/삭제에서 자동 제외, 태깅엔 포함된다.
  const toggleSelectGroup = (ids: string[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const clearSelection = () => {
    setSelectedIds(new Set());
    setBatchNote(null);
    setBatchNoteErr(true);
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
    setBatchNoteErr(true); // 토글/태그/삭제 배치 노트는 항상 오류 스타일(실패 메시지).
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

  // 배치 적용/해제(G2-PR2, ADR-0006 레일 ①) — managed 스킬만 대상(외부/인앱 제외). 백엔드가
  // best-effort 처리하고 항목별 결과를 돌려준다. 충돌은 덮어쓰지 않고 스킵된다.
  const applyBatch = useApplyManagedSkills();
  const unapplyBatch = useUnapplyManagedSkills();
  const applyTargets = batchApplyTargets(list, selectedIds);
  const batchApplyBusy = applyBatch.isPending || unapplyBatch.isPending;

  const toRefs = (skills: typeof applyTargets): SkillRef[] =>
    // batchApplyTargets가 provider != null만 통과시키므로 여기서 provider는 항상 존재한다.
    skills.map((s) => ({ provider: s.provider as SkillProvider, name: s.name }));

  const runBatchApply = (remove: boolean) => {
    if (batchApplyBusy || applyTargets.length === 0) return;
    setBatchNote(null);
    const refs = toRefs(applyTargets);
    const mut = remove ? unapplyBatch : applyBatch;
    mut.mutate(refs, {
      // clearSelection()이 batchNote/Err를 리셋하므로 요약·중립 플래그는 선택 해제 *후*에 설정한다.
      onSuccess: (results) => {
        clearSelection();
        setBatchNote(summarizeBatch(results));
        setBatchNoteErr(false); // 적용/해제 결과 요약은 중립(정보) 스타일.
      },
      onError: () => {
        setBatchNote("배치 적용에 실패했습니다");
        setBatchNoteErr(true);
      },
    });
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
            setInstalling(false);
            setSelectedId(null);
          }}
        >
          <Plus className="size-4" />
          인앱 프롬프트 추가
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => {
            setInstalling(true);
            setAdding(false);
            setSelectedId(null);
          }}
        >
          <Download className="size-4" />
          URL로 설치
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => {
            setBackupOpen(true);
            setAdding(false);
            setInstalling(false);
            setSelectedId(null);
          }}
        >
          <Archive className="size-4" />
          백업/복원
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => {
            setUpdateOpen(true);
            setAdding(false);
            setInstalling(false);
            setBackupOpen(false);
            setSelectedId(null);
          }}
        >
          <RefreshCw className="size-4" />
          업데이트
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
          {applyTargets.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full"
                disabled={batchApplyBusy}
                onClick={() => runBatchApply(false)}
                aria-label="선택한 라이브러리 스킬 적용"
              >
                <Link2 className="size-4" />
                {applyBatch.isPending ? "적용 중…" : `선택 적용 (${applyTargets.length})`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full"
                disabled={batchApplyBusy}
                onClick={() => runBatchApply(true)}
                aria-label="선택한 라이브러리 스킬 적용 해제"
              >
                <Unlink className="size-4" />
                {unapplyBatch.isPending ? "해제 중…" : `적용 해제 (${applyTargets.length})`}
              </Button>
            </>
          )}
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
          {batchNote && (
            <span className={cn("skl-note skl-batch-note-err", batchNoteErr && "err")}>
              {batchNote}
            </span>
          )}
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
          {workspaceNav.length > 0 && (
            <>
              <div className="skl-group-label skl-sidebar-group">프로젝트</div>
              {workspaceNav.map((item) => (
                <EnvNavButton
                  key={item.id}
                  item={item}
                  count={envCounts(item, filtered)}
                  active={(activeEnv?.id ?? "all") === item.id}
                  onSelect={() => setActiveEnvId(item.id)}
                  onDragStart={() => {}}
                  onDropItem={() => {}}
                />
              ))}
            </>
          )}
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
                {segment.groups.map((g) => {
                  const s = g.skill;
                  const groupSelected = g.memberIds.every((id) => selectedIds.has(id));
                  return (
                    <div key={s.id} className={cn("skl-card-wrap", groupSelected && "selected")}>
                      <input
                        type="checkbox"
                        className="skl-card-check"
                        checked={groupSelected}
                        onChange={() => toggleSelectGroup(g.memberIds)}
                        aria-label={`${s.name} 선택`}
                      />
                      <SkillCard
                        skill={s}
                        locations={g.locations}
                        listView={listView}
                        active={s.id === selectedId}
                        onSelect={() => {
                          setSelectedId(s.id);
                          setAdding(false);
                        }}
                      />
                    </div>
                  );
                })}
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
                : installing
                  ? "URL에서 설치"
                  : backupOpen
                    ? "백업 / 복원"
                    : updateOpen
                      ? "업데이트"
                      : selected?.kind === "external"
                        ? "외부 스킬"
                        : selected?.kind === "managed"
                          ? "라이브러리 스킬"
                          : "인앱 프롬프트"}
            </SheetTitle>
            {!adding && selectedGroup.length > 1 && (
              <div className="skl-sheet-switch" role="group" aria-label="위치 전환">
                <span className="skl-sheet-switch-label">{selectedGroup.length}곳</span>
                {selectedGroup.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    className={cn("skl-sheet-switch-chip", loc.id === selectedId && "active")}
                    aria-pressed={loc.id === selectedId}
                    title={loc.sourcePath ?? undefined}
                    onClick={() => setSelectedId(loc.id)}
                  >
                    {providerLabel(loc.provider)}
                  </button>
                ))}
              </div>
            )}
            <div className="skl-sheet-body">
              {adding ? (
                <CreatePanel
                  onDone={(id) => {
                    setAdding(false);
                    if (id) setSelectedId(id);
                    else closeSheet();
                  }}
                />
              ) : installing ? (
                <InstallPanel
                  onDone={(id) => {
                    setInstalling(false);
                    if (id) setSelectedId(id);
                    else closeSheet();
                  }}
                />
              ) : backupOpen ? (
                <BackupPanel onDone={() => closeSheet()} />
              ) : updateOpen ? (
                <UpdatePanel onDone={() => closeSheet()} />
              ) : selected?.kind === "in_app_prompt" ? (
                <InAppEditor key={selected.id} skill={selected} />
              ) : selected?.kind === "external" ? (
                <ExternalViewer key={selected.id} skill={selected} onImported={closeSheet} />
              ) : selected?.kind === "managed" ? (
                <ManagedViewer key={selected.id} skill={selected} onRemoved={closeSheet} />
              ) : null}
            </div>
          </SheetContent>
        )}
      </Sheet>

      <SkillsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** 본문 카드 섹션 분류(그룹 단위). 도구 간 동일 스킬(2곳 이상)은 맨 위 "공유 스킬" 섹션으로 모으고,
 * 단일 위치 스킬만 기존 provider 섹션에 둔다(#4). 외부 귀속은 백엔드 `Skill.provider`(P0)를 직접 쓴다
 * — 경로추론(구 `providerOf`) 폐기. in-app은 binding 유무로 Global/Project를 나눈다(항상 단일 위치). */
function segmentSkills(groups: GroupedSkill[]) {
  const single = (g: GroupedSkill) => g.locations.length === 1;
  const defs = [
    {
      key: "shared",
      label: "공유 스킬 (여러 도구)",
      match: (g: GroupedSkill) => g.locations.length > 1,
    },
    {
      key: "global",
      label: "Global Skills",
      match: (g: GroupedSkill) => single(g) && g.skill.kind === "in_app_prompt" && !g.skill.binding,
    },
    {
      key: "project",
      label: "Project Skills",
      match: (g: GroupedSkill) =>
        single(g) && g.skill.kind === "in_app_prompt" && !!g.skill.binding,
    },
    {
      key: "external-claude",
      label: "External Skills · Claude",
      match: (g: GroupedSkill) => single(g) && g.skill.provider === "claude",
    },
    {
      key: "external-codex",
      label: "External Skills · Codex",
      match: (g: GroupedSkill) => single(g) && g.skill.provider === "codex",
    },
    {
      key: "external-openclaw",
      label: "External Skills · OpenClaw",
      match: (g: GroupedSkill) => single(g) && g.skill.provider === "openclaw",
    },
    {
      key: "external-hermes",
      label: "External Skills · Hermes",
      match: (g: GroupedSkill) => single(g) && g.skill.provider === "hermes",
    },
    {
      key: "external-other",
      label: "External Skills · Other",
      match: (g: GroupedSkill) => single(g) && g.skill.provider === "other",
    },
  ];
  return defs
    .map((def) => {
      const group = groups.filter(def.match);
      return {
        key: def.key,
        label: def.label,
        health: `${group.filter((g) => g.skill.enabled).length}/${group.length}`,
        groups: group.sort((a, b) => a.skill.name.localeCompare(b.skill.name)),
      };
    })
    .filter((seg) => seg.groups.length > 0);
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

/** 레지스트리 카드(인앱/외부 공통). 클릭하면 Sheet로 보기/편집. grid/list 두 변형. 도구 간 그룹
 * 카드(`locations.length > 1`)는 단일 provider 배지 대신 "N곳" + 출처 칩(중복 제거)을 보여준다(#4). */
function SkillCard({
  skill,
  locations,
  listView,
  active,
  onSelect,
}: {
  skill: Skill;
  locations: SkillLocation[];
  listView: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const isInApp = skill.kind === "in_app_prompt";
  const Icon = isInApp ? Blocks : FileText;
  const desc = (skill.prompt ?? "").trim();
  const sub = isInApp ? skill.binding : skill.sourcePath ? compactPath(skill.sourcePath) : null;
  const grouped = locations.length > 1;
  // 그룹 카드는 대표의 단일 provider 배지를 빼고(아래에서 출처 칩으로 대체) kind/off만 남긴다.
  const badges = grouped
    ? skillCardBadges(skill).filter((b) => b.tone !== "provider")
    : skillCardBadges(skill);
  const providers = grouped ? groupProviders(locations) : [];

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
          {grouped && (
            <>
              <span className="skl-badge skl-badge-locs">{locations.length}곳</span>
              {providers.map((p) => (
                <span key={p} className="skl-badge skl-badge-provider">
                  {providerLabel(p)}
                </span>
              ))}
            </>
          )}
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

/** 기본값(코드 상수) ↔ 현재 편집본 라인 diff 렌더(#18). remove=기본에만/add=현재에만/equal=공통.
 * 표시 전용 — 신규 의존성 없이 `lineDiff`(LCS) 결과를 +/− 거터로 보여준다. */
function SkillPromptDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="skl-diff" role="region" aria-label="기본값과의 차이">
      {lines.map((l, idx) => (
        <div key={`${idx}-${l.op}`} className={cn("skl-diff-line", `skl-diff-${l.op}`)}>
          <span className="skl-diff-gutter" aria-hidden="true">
            {l.op === "add" ? "+" : l.op === "remove" ? "−" : " "}
          </span>
          <span className="skl-diff-text">{l.text || " "}</span>
        </div>
      ))}
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
  // 기본값(코드 상수)과의 diff 펼침 여부(#18). 스킬 전환 시 초기화.
  const [showDiff, setShowDiff] = useState(false);

  // 다른 스킬로 전환 시 폼 동기화 — prev-compare로 render에서 적용 (set-state-in-effect 회피).
  // (key 재마운트가 1차 — 이건 안전망.)
  const [seededId, setSeededId] = useState(skill.id);
  if (skill.id !== seededId) {
    setSeededId(skill.id);
    setPrompt(skill.prompt ?? "");
    setName(skill.name);
    setShowDiff(false);
  }

  const dirty = prompt !== (skill.prompt ?? "") || name !== skill.name;

  // #18: 시드 binding을 가진 인앱 프롬프트만 코드 상수 폴백이 있다(외부/미시드는 null → diff 비대상).
  // 현재 편집본(prompt)을 기본값과 비교 — 같으면 "기본값과 동일", 다르면 diff/복원 노출.
  const fallback = skill.fallbackPrompt;
  const diff = useMemo(
    () => (fallback != null ? lineDiff(fallback, prompt) : []),
    [fallback, prompt],
  );
  const customized = fallback != null && prompt !== fallback;
  const stats = diffStats(diff);

  // 기본값으로 복원: prompt를 코드 상수로 되돌린다(로컬 상태 — 저장해야 영속, 가역). #1: 사람 발동.
  const resetToDefault = () => {
    if (fallback == null) return;
    setPrompt(fallback);
    setShowDiff(false);
    setNote("기본값으로 되돌렸습니다 — 저장하면 적용됩니다.");
  };

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

      {fallback != null && (
        <div className="skl-fallback">
          {customized ? (
            <>
              <span className="skl-fallback-label">
                기본값과 다름{" "}
                <span className="skl-fallback-stat">
                  +{stats.added} −{stats.removed}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 rounded-full"
                aria-pressed={showDiff}
                onClick={() => setShowDiff((v) => !v)}
              >
                <GitCompare className="size-4" />
                {showDiff ? "비교 숨기기" : "기본값과 비교"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 rounded-full"
                onClick={resetToDefault}
              >
                <RotateCcw className="size-4" />
                기본값으로 복원
              </Button>
            </>
          ) : (
            <span className="skl-fallback-label muted">기본값과 동일</span>
          )}
        </div>
      )}

      {customized && showDiff && <SkillPromptDiff lines={diff} />}

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

/** 외부 스킬 뷰어(SKILL.md 내용). 사용자 명시 편집 가능(자기 파일). 실행은 절대 없음.
 * "라이브러리로 import"는 이 스킬을 work-radar 중앙 라이브러리로 복사한다(가역·감사 — 레일 ①②). */
function ExternalViewer({ skill, onImported }: { skill: Skill; onImported: () => void }) {
  const path = skill.sourcePath ?? null;
  const content = useExternalSkillContent(path);
  const write = useWriteExternalSkill();
  const importSkill = useImportExternalSkill();

  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const body = content.data ?? "";
  const dirty = editing && draft !== null && draft !== body;
  const canImport = !!path && !!skill.provider;

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

  // 라이브러리로 import: 외부 파일은 읽기만 하고 중앙으로 복사(원본 무손상). 성공 시 목록이 갱신되며
  // 이 발견본은 managed로 대체(억제)되므로 Sheet를 닫는다. 자동 실행 없음(#1/#2 — 파일 복사일 뿐).
  const importToLibrary = () => {
    if (!path || !skill.provider || importSkill.isPending) return;
    setNote(null);
    importSkill.mutate(
      { path, provider: skill.provider },
      {
        onSuccess: onImported,
        onError: (e) => setNote(`import 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <span className="skl-name-static">{skill.name}</span>
        {!editing ? (
          <>
            {canImport && (
              <Button
                variant="outline"
                className="gap-1.5 rounded-full"
                onClick={importToLibrary}
                disabled={importSkill.isPending}
                title="이 스킬을 work-radar 라이브러리로 복사(가역·감사)"
              >
                <FolderInput className="size-4" />
                {importSkill.isPending ? "import 중…" : "라이브러리로 import"}
              </Button>
            )}
            <Button className="rounded-full" onClick={startEdit}>
              파일 편집
            </Button>
          </>
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

/** 라이브러리(managed) 스킬 뷰어 — work-radar가 소유한 중앙 라이브러리 스킬(G1-PR3). 메타데이터 + 제거.
 * 중앙 파일 내용 뷰어는 G1 비대상(readExternalSkill 가드가 외부 루트 전용 — 중앙 경로 비대상). "라이브러리
 * 에서 제거"는 중앙 복사본만 지운다(외부 원본 무손상, 감사 — 레일 ①②). 자동 실행 없음(#1/#2). */
function ManagedViewer({ skill, onRemoved }: { skill: Skill; onRemoved: () => void }) {
  const remove = useRemoveManagedSkill();
  const applied = useAppliedSkills();
  const apply = useApplyManagedSkill();
  const unapply = useUnapplyManagedSkill();
  const [note, setNote] = useState<string | null>(null);
  const desc = (skill.prompt ?? "").trim();

  // 적용 상태는 디스크 심링크에서 유도(레일 ①, INVARIANT #7) — provider+name으로 매칭.
  const appliedEntry = (applied.data ?? []).find(
    (a) => a.provider === skill.provider && a.name === skill.name,
  );
  const isApplied = !!appliedEntry;
  const applyBusy = apply.isPending || unapply.isPending;

  const removeFromLibrary = () => {
    if (!skill.provider || remove.isPending) return;
    if (
      !window.confirm(
        `'${skill.name}'을(를) 라이브러리에서 제거할까요? (원본 외부 파일은 그대로 유지됩니다)`,
      )
    )
      return;
    setNote(null);
    remove.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: onRemoved,
        onError: (e) => setNote(`제거 실패: ${(e as Error).message}`),
      },
    );
  };

  const applyToAgent = () => {
    if (!skill.provider || applyBusy) return;
    setNote(null);
    apply.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: (path) => setNote(`적용됨 → ${path}`),
        onError: (e) => setNote(`적용 실패: ${(e as Error).message}`),
      },
    );
  };

  const unapplyFromAgent = () => {
    if (!skill.provider || applyBusy) return;
    setNote(null);
    unapply.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: () => setNote("적용 해제됨 (심링크 제거 · 사용자 파일 무손상)"),
        onError: (e) => setNote(`해제 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <span className="skl-name-static">{skill.name}</span>
        <Button
          variant="outline"
          className="gap-1.5 rounded-full"
          onClick={removeFromLibrary}
          disabled={!skill.provider || remove.isPending}
        >
          <Trash2 className="size-4" />
          {remove.isPending ? "제거 중…" : "라이브러리에서 제거"}
        </Button>
      </div>

      <div className="skl-bind-line">
        <Library className="mr-1 inline size-3.5 align-text-bottom" />
        라이브러리 관리 중 · 출처 {providerLabel(skill.provider)}
        {isApplied && " · 에이전트에 적용됨"}
      </div>
      {desc && <div className="skl-desc">{desc}</div>}

      {/* 에이전트 dir 적용/해제(G2-PR1, ADR-0006 레일 ① — 심링크, 가역·감사). 인라인 — Dialog 없음. */}
      <div className="skl-actions">
        {isApplied ? (
          <Button
            variant="outline"
            className="gap-1.5 rounded-full"
            onClick={unapplyFromAgent}
            disabled={!skill.provider || applyBusy}
          >
            <Unlink className="size-4" />
            {unapply.isPending ? "해제 중…" : "적용 해제"}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="gap-1.5 rounded-full"
            onClick={applyToAgent}
            disabled={!skill.provider || applyBusy}
          >
            <Link2 className="size-4" />
            {apply.isPending ? "적용 중…" : `${providerLabel(skill.provider)}에 적용`}
          </Button>
        )}
      </div>

      <SkillTagsEditor skill={skill} />

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

/** GitHub URL에서 스킬 설치 패널(G1.5-PR1, ADR-0006 레일 ③). URL + provider 선택 → 중앙 라이브러리로
 * 설치(가역·감사). 네트워크/토큰은 Rust(렌더러 비노출). 공개 repo 우선 — 비공개 인증은 후속 라운드.
 * 자동 실행 없음(#1/#2 — tarball 받아 파일 복사일 뿐). */
function InstallPanel({ onDone }: { onDone: (id: string | null) => void }) {
  const install = useInstallSkillFromGit();
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<SkillProvider>("claude");
  const [note, setNote] = useState<string | null>(null);

  const submit = () => {
    const u = url.trim();
    if (!u || install.isPending) return;
    setNote(null);
    install.mutate(
      { url: u, provider },
      {
        onSuccess: (s) => onDone(s.id),
        onError: (e) => setNote(`설치 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-mono"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="github.com/owner/repo[@ref][#subpath]"
          aria-label="설치할 GitHub repo URL"
        />
        <Select value={provider} onValueChange={(v) => setProvider(v as SkillProvider)}>
          <SelectTrigger className="w-auto min-w-[120px]" aria-label="대상 provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
            <SelectItem value="openclaw">OpenClaw</SelectItem>
            <SelectItem value="hermes">Hermes</SelectItem>
            <SelectItem value="other">기타</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="skl-desc">
        공개 GitHub repo의 스킬을 라이브러리로 설치합니다. 네트워크 호출은 Rust에서 bounded로
        처리되고 모든 쓰기는 감사됩니다. 스킬은 설치만 되며 자동 실행되지 않습니다.
      </p>
      <div className="skl-actions">
        <Button
          className="gap-1.5 rounded-full"
          onClick={submit}
          disabled={!url.trim() || install.isPending}
        >
          <Download className="size-4" />
          {install.isPending ? "설치 중…" : "설치"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

/**
 * 백업/복원 패널(G1.5-PR2). 중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업하고, 스냅샷으로 복원한다.
 * 복원 confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet overlay-stack / Esc 계약 무영향). 모든 작업은
 * 로컬 파일 복사 + 감사(잡 비취급 — #1/#2). 복원은 직전 상태를 사전 안전 스냅샷으로 보존하므로 가역.
 */
function BackupPanel({ onDone }: { onDone: () => void }) {
  const backups = useSkillBackups();
  const backup = useBackupSkillLibrary();
  const restore = useRestoreSkillLibrary();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doBackup = () => {
    if (backup.isPending) return;
    setNote(null);
    backup.mutate(undefined, {
      onSuccess: (m) => setNote(`백업 완료: ${m.skillCount}개 스킬 (${m.id})`),
      onError: (e) => setNote(`백업 실패: ${(e as Error).message}`),
    });
  };

  const doRestore = (id: string) => {
    if (restore.isPending) return;
    setNote(null);
    restore.mutate(id, {
      onSuccess: () => {
        setConfirmId(null);
        onDone();
      },
      onError: (e) => setNote(`복원 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="skl-edit">
      <p className="skl-desc">
        중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업합니다. 복원은 직전 상태를 안전 스냅샷으로
        보존한 뒤 교체하므로 되돌릴 수 있습니다. 모든 작업은 로컬 파일 복사이며 감사됩니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doBackup} disabled={backup.isPending}>
          <Archive className="size-4" />
          {backup.isPending ? "백업 중…" : "지금 백업"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {(backups.data ?? []).map((b) => (
          <li key={b.id} className="skl-backup-row">
            <span className="font-mono">{b.createdAt}</span>
            <span className="skl-desc">{b.skillCount}개 스킬</span>
            {confirmId === b.id ? (
              <span className="skl-actions">
                <Button
                  size="sm"
                  className="rounded-full"
                  onClick={() => doRestore(b.id)}
                  disabled={restore.isPending}
                >
                  {restore.isPending ? "복원 중…" : "정말 복원"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => setConfirmId(null)}
                >
                  취소
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                onClick={() => setConfirmId(b.id)}
              >
                복원…
              </Button>
            )}
          </li>
        ))}
        {backups.data?.length === 0 && <li className="skl-desc">아직 백업이 없습니다.</li>}
      </ul>
    </div>
  );
}

/**
 * 업데이트 패널(G1.5-PR3). 추적 스킬의 업스트림을 확인(fetch-only·bounded·staging만)하고, 새 버전을
 * 적용(사전 전체 백업 후 교체 — 가역)하며, per-skill auto-update와 on-launch opt-in을 토글한다. 적용
 * confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet Esc 계약 무영향). 자동 실행/적용 없음(#1/#2).
 */
function UpdatePanel({ onDone }: { onDone: () => void }) {
  const status = useSkillUpdateStatus();
  const check = useCheckSkillUpdates();
  const setAuto = useSetSkillAutoUpdate();
  const apply = useApplySkillUpdate();
  const onLaunch = useSkillUpdateOnLaunch();
  const setOnLaunch = useSetSkillUpdateOnLaunch();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doCheck = () => {
    if (check.isPending) return;
    setNote(null);
    check.mutate(undefined, {
      onSuccess: (rows) => {
        const n = rows.filter((r) => r.updateAvailable).length;
        setNote(n > 0 ? `${n}개 업데이트 가능` : "모두 최신입니다");
      },
      onError: (e) => setNote(`확인 실패: ${(e as Error).message}`),
    });
  };

  const doApply = (provider: SkillProvider, name: string) => {
    if (apply.isPending) return;
    setNote(null);
    apply.mutate(
      { provider, name },
      {
        onSuccess: () => setConfirmKey(null),
        onError: (e) => setNote(`적용 실패: ${(e as Error).message}`),
      },
    );
  };

  const rows = status.data ?? [];
  return (
    <div className="skl-edit">
      <p className="skl-desc">
        설치한 스킬의 업스트림을 확인합니다. 네트워크는 Rust에서 bounded로 처리되고, 새 버전은
        staging에만 받아둡니다 — 적용은 아래에서 직접 누를 때만 일어나며 자동 실행은 없습니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doCheck} disabled={check.isPending}>
          <RefreshCw className="size-4" />
          {check.isPending ? "확인 중…" : "지금 확인"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      <label className="skl-update-launch">
        <Switch checked={!!onLaunch.data} onCheckedChange={(v) => setOnLaunch.mutate(v)} />
        <span className="skl-desc">앱 시작 시 자동 확인(opt-in · 한 번만 · 자동 적용 안 함)</span>
      </label>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {rows.map((r) => {
          const key = `${r.provider}:${r.name}`;
          return (
            <li key={key} className="skl-backup-row">
              <span className="font-mono">{r.name}</span>
              <div className="skl-update-ctl">
                {r.updateAvailable && <Badge variant="default">업데이트 가능</Badge>}
                <label className="skl-update-toggle">
                  <Switch
                    checked={r.autoUpdate}
                    onCheckedChange={(v) =>
                      setAuto.mutate({
                        provider: r.provider as SkillProvider,
                        name: r.name,
                        enabled: v,
                      })
                    }
                  />
                  <span className="skl-desc">자동</span>
                </label>
                {r.updateAvailable &&
                  (confirmKey === key ? (
                    <>
                      <Button
                        size="sm"
                        className="rounded-full"
                        disabled={apply.isPending}
                        onClick={() => doApply(r.provider as SkillProvider, r.name)}
                      >
                        {apply.isPending ? "적용 중…" : "정말 적용"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-full"
                        onClick={() => setConfirmKey(null)}
                      >
                        취소
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      onClick={() => setConfirmKey(key)}
                    >
                      적용…
                    </Button>
                  ))}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="skl-desc">설치된(추적 중인) 스킬이 없습니다.</li>}
      </ul>
    </div>
  );
}

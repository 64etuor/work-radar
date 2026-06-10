import "./SkillsView.css";
import "./SkillsTags.css";

import {
  Archive,
  CircleHelp,
  Download,
  LayoutGrid,
  Link2,
  List,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Tag,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Skill, SkillProvider, SkillRef } from "@/bindings";
import { SkillsHelpDialog } from "@/components/SkillsHelpDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  useApplyManagedSkills,
  useDeleteSkill,
  useSetSkillTags,
  useSkillDivergences,
  useSkillEnvironments,
  useSkills,
  useSkillWorkspaces,
  useUnapplyManagedSkills,
  useUpdateSkill,
} from "@/lib/query";
import { providerLabel } from "@/lib/skillBadges";
import {
  addTagToSkill,
  batchApplyTargets,
  batchMutableTargets,
  batchTaggableTargets,
  selectedSkills,
  summarizeBatch,
} from "@/lib/skillBatch";
import { groupCrossToolSkills, type GroupedSkill, type SkillLocation } from "@/lib/skillDedup";
import {
  applyEnvOrder,
  buildDivergedLocationLabels,
  buildDivergedPathSet,
  buildSkillEnvNav,
  buildSkillWorkspaceNav,
  buildWorkspaceHealth,
  envCounts,
  reorderEnv,
} from "@/lib/skillEnvNav";
import { collectTags, matchesTag, UNTAGGED } from "@/lib/skillTags";
import { usePendingFocus } from "@/lib/usePendingFocus";
import { useStickyToggle } from "@/lib/useStickyToggle";
import { useUIStore } from "@/store";

import { EnvNavButton } from "./skills/EnvNavButton";
import { ExternalViewer } from "./skills/ExternalViewer";
import { InAppEditor } from "./skills/InAppEditor";
import { ManagedViewer } from "./skills/ManagedViewer";
import { AuditPanel, BackupPanel, CreatePanel, InstallPanel, UpdatePanel } from "./skills/panels";
import { SkillCard } from "./skills/SkillCard";

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
  const divergences = useSkillDivergences();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // URL(GitHub) 설치 패널 열림 — adding과 배타. 외부 상태 불변(파일 복사·감사, #1/#2).
  const [installing, setInstalling] = useState(false);
  // 백업/복원 패널 열림 — 다른 패널과 배타. 로컬 파일 스냅샷·감사(잡 비취급, #1/#2).
  const [backupOpen, setBackupOpen] = useState(false);
  // 업데이트 패널 열림 — 확인/토글/적용/런치설정. fetch-only·staging만(적용은 사용자 발동, #1/#2).
  const [updateOpen, setUpdateOpen] = useState(false);
  // 감사 로그 패널 열림 — 읽기 전용(append-only skill_audit_log 뷰어, 쓰기/잡 비취급, #1/#2).
  const [auditOpen, setAuditOpen] = useState(false);
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

  // 팔레트에서 스킬을 고르면 그 스킬을 선택(보기/편집)한다 — 한 번만 소비(공유 훅 usePendingFocus,
  // 시그널 딥링크와 동일 패턴). 동일 선택 핸들러(selectedId) 경로라 자동 실행은 없다(INVARIANT #1).
  usePendingFocus(pendingSkillId, clearPendingSkill, (id) => {
    setSelectedId(id);
    setAdding(false);
  });

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
  const divergedPaths = useMemo(() => buildDivergedPathSet(divergences.data), [divergences.data]);
  // per-location 귀속(#6 ff): diverged memberPath → 프로젝트 라벨. 카드 마커가 "어느 프로젝트가 다른지" 표기.
  const locationLabels = useMemo(
    () => buildDivergedLocationLabels(divergences.data, workspaces.data),
    [divergences.data, workspaces.data],
  );
  // 사이드바 sync 헬스(#17): 워크스페이스별 diverged 멤버 수(repoId 키). divergences가 단일 출처(C6).
  const workspaceHealth = useMemo(() => buildWorkspaceHealth(divergences.data), [divergences.data]);
  const totalDiverged = useMemo(
    () => [...workspaceHealth.values()].reduce((a, b) => a + b, 0),
    [workspaceHealth],
  );
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
  const sheetOpen = adding || installing || backupOpen || updateOpen || auditOpen || !!selected;
  const closeSheet = () => {
    setAdding(false);
    setInstalling(false);
    setBackupOpen(false);
    setUpdateOpen(false);
    setAuditOpen(false);
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
      {/* 한 줄 헤더: 타이틀(좌, drag-region) + 컨트롤 아이콘(우, 세로 중앙). 컨트롤은 drag-region
          밖에 둬야 드래그가 입력/클릭을 삼키지 않는다(InboxView 선례). */}
      <header className="skl-head">
        <div className="skl-head-title" data-tauri-drag-region>
          <span className="skl-title">스킬 레지스트리</span>
          <span className="skl-count">{total}</span>
        </div>
        <div className="skl-toolbar">
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

          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 rounded-full"
            onClick={() => {
              setAuditOpen(true);
              setAdding(false);
              setInstalling(false);
              setBackupOpen(false);
              setUpdateOpen(false);
              setSelectedId(null);
            }}
          >
            <ScrollText className="size-4" />
            감사 로그
          </Button>
        </div>
      </header>

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
          <div className="skl-sidebar-search" aria-label="스킬 목록 검색">
            <div className="skl-search">
              <Search className="size-3.5" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="스킬 검색"
                aria-label="스킬 검색"
              />
            </div>
          </div>
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
              <div className="skl-group-label skl-sidebar-group">
                프로젝트
                {totalDiverged > 0 && (
                  <span className="skl-env-diverged" title={`중앙과 다른 카피 ${totalDiverged}개`}>
                    {totalDiverged} 다름
                  </span>
                )}
              </div>
              {workspaceNav.map((item) => (
                <EnvNavButton
                  key={item.id}
                  item={item}
                  count={envCounts(item, filtered)}
                  diverged={item.repoId ? workspaceHealth.get(item.repoId) : undefined}
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
                      {(() => {
                        // diverged location들을 프로젝트 라벨로 귀속(#6 ff). divergedPaths=멤버십 판정,
                        // locationLabels=이름. 둘 다 divergences 단일 출처라 키 집합 동일.
                        const names = [
                          ...new Set(
                            g.locations
                              .filter(
                                (l) => l.sourcePath != null && divergedPaths.has(l.sourcePath),
                              )
                              .map((l) => locationLabels.get(l.sourcePath as string))
                              .filter((v): v is string => v != null),
                          ),
                        ];
                        if (names.length === 0) return null;
                        return (
                          <span
                            className="skl-card-diverged"
                            title={`중앙과 다름: ${names.join(", ")}`}
                          >
                            {names.length === 1 ? `·다름 (${names[0]})` : `·다름 (${names.length})`}
                          </span>
                        );
                      })()}
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
                      : auditOpen
                        ? "감사 로그"
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
              ) : auditOpen ? (
                <AuditPanel onDone={() => closeSheet()} />
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

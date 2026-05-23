import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { WorkSignal } from "@/bindings";
import {
  areaLabel,
  kindChipClass,
  kindLabel,
  quadrantToZone,
  shortDate,
  suggestedQuadrantBadge,
  ZONES,
  type ZoneKey,
} from "@/components/board/board-utils";

const CW = 150;
const CH = 92;
const GAP = 12;

type DropTarget = ZoneKey | "today";

type Props = {
  signals: WorkSignal[];
  selectedId: string | null;
  /** 새로 등장(pop)시킬 카드 id 집합 (capture/return). */
  poppedIds: Set<string>;
  onSelect: (id: string | null) => void;
  /** 카드를 존으로 분류 (드래그/키보드와 무관하게 공통). */
  onClassify: (id: string, zone: ZoneKey) => void;
  /** Today 패널로 드롭 → 승격. */
  onPromoteToday: (id: string) => void;
  /** ⋯ 메뉴 열기. */
  onOpenMenu: (id: string, anchor: HTMLElement) => void;
  /** 인라인 제목 편집 중인 카드 id (없으면 null). */
  editingId: string | null;
  /** 카드 제목 편집 시작(더블클릭 또는 메뉴 edit). */
  onEditStart: (id: string) => void;
  /** 편집 확정(트림 후 빈 값/무변경은 호출자가 무시). */
  onEditCommit: (id: string, title: string) => void;
  /** 편집 취소(Esc). */
  onEditCancel: () => void;
  /** 미분류 전체 배치 enrich 실행 (단일 codex 잡 — Phase 15 #4). */
  onEnrichAll: () => void;
  /** codex 미가용 또는 미분류 0개면 배치 enrich 버튼 비활성. */
  enrichAllDisabled: boolean;
  /** Today 패널 DOM (드롭 히트 테스트용). */
  todayPanelRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * 미분류(좌) + 아이젠하워 2×2(중앙) 캔버스.
 * 포스트잇은 absolute로 배치되고, 서버 신호 목록이 바뀔 때마다 imperative하게 재배치된다.
 * 드래그는 pointer 이벤트 + ref 기반 라이브 위치, 드롭 시에만 서버 commit.
 */
export function MatrixCanvas({
  signals,
  selectedId,
  poppedIds,
  onSelect,
  onClassify,
  onPromoteToday,
  onOpenMenu,
  editingId,
  onEditStart,
  onEditCommit,
  onEditCancel,
  onEnrichAll,
  enrichAllDisabled,
  todayPanelRef,
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const inboxRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Record<ZoneKey, HTMLDivElement | null>>({
    unclassified: null,
    q1: null,
    q2: null,
    q3: null,
    q4: null,
  });
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  /** 부트 fan-out을 한 번만 적용하기 위한 플래그. */
  const bootedRef = useRef(false);

  // 최신 콜백/데이터를 드래그 핸들러가 참조하도록 ref에 보관 (리스너 재바인딩 회피).
  const cbRef = useRef({ onClassify, onPromoteToday, onSelect });
  cbRef.current = { onClassify, onPromoteToday, onSelect };
  const signalsRef = useRef(signals);
  signalsRef.current = signals;

  const zoneOf = (s: WorkSignal): ZoneKey => quadrantToZone(s.quadrant);

  const rectIn = (el: HTMLElement) => {
    const o = canvasRef.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
  };

  const zoneEl = (z: ZoneKey): HTMLDivElement | null => cellRefs.current[z];

  const fitInbox = () => {
    const inbox = inboxRef.current;
    if (!inbox) return;
    const n = signalsRef.current.filter((s) => zoneOf(s) === "unclassified").length;
    const w = inbox.getBoundingClientRect().width;
    const cols = Math.max(1, Math.floor((w - 24) / (CW + GAP)));
    const rows = Math.max(1, Math.ceil((n || 1) / cols));
    inbox.style.height = `${40 + rows * (CH + GAP) + 8}px`;
  };

  const place = (
    el: HTMLDivElement,
    x: number,
    y: number,
    rot: number,
    fromOrigin: boolean,
    i: number,
  ) => {
    if (fromOrigin && canvasRef.current) {
      const o = canvasRef.current.getBoundingClientRect();
      el.style.transition = "none";
      el.style.left = `${o.width / 2 - CW / 2}px`;
      el.style.top = `${o.height - 40}px`;
      el.style.transform = "scale(.34)";
      el.style.opacity = "0";
      el.getBoundingClientRect(); // reflow
      window.setTimeout(() => {
        el.style.transition = "";
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.transform = `rotate(${rot || 0}deg)`;
        el.style.opacity = "1";
      }, 70 + i * 80);
    } else {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.transform = `rotate(${rot || 0}deg)`;
      el.style.opacity = "1";
    }
  };

  const layoutZone = (zone: ZoneKey, anim: boolean) => {
    const el = zoneEl(zone);
    if (!el) return;
    if (zone === "unclassified") {
      if (window.innerWidth <= 900) fitInbox();
      else if (inboxRef.current) inboxRef.current.style.height = "";
    }
    const list = signalsRef.current.filter((s) => zoneOf(s) === zone);
    const z = rectIn(el);
    if (zone === "unclassified") {
      const cols = Math.max(1, Math.floor((z.w - 24) / (CW + GAP)));
      if (cols <= 1) {
        const top = z.y + 40;
        const bot = z.y + z.h - CH - 8;
        const step = list.length > 1 ? Math.min(58, (bot - top) / (list.length - 1)) : 0;
        list.forEach((s, i) => {
          const el2 = cardRefs.current.get(s.id);
          if (el2) place(el2, z.x + 16 + (i % 2) * 12, top + i * step, i % 2 ? 2 : -2, anim, i);
        });
      } else {
        list.forEach((s, i) => {
          const el2 = cardRefs.current.get(s.id);
          const col = i % cols;
          const row = (i / cols) | 0;
          if (el2) place(el2, z.x + 14 + col * (CW + GAP), z.y + 40 + row * (CH + GAP), 0, anim, i);
        });
      }
      return;
    }
    const cols = Math.max(1, Math.floor((z.w - 28) / (CW + GAP)));
    list.forEach((s, i) => {
      const el2 = cardRefs.current.get(s.id);
      const col = i % cols;
      const row = (i / cols) | 0;
      if (el2) place(el2, z.x + 14 + col * (CW + GAP), z.y + 38 + row * (CH + GAP), 0, false, i);
    });
  };

  const layoutAll = (animInbox: boolean) => {
    layoutZone("unclassified", animInbox);
    (["q1", "q2", "q3", "q4"] as ZoneKey[]).forEach((z) => layoutZone(z, false));
  };

  // 신호 목록이 바뀔 때마다 재배치 (서버 refetch 후).
  useLayoutEffect(() => {
    const firstBoot = !bootedRef.current;
    bootedRef.current = true;
    layoutAll(firstBoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals]);

  // resize 시 재배치.
  useEffect(() => {
    let rt: number | undefined;
    const onResize = () => {
      window.clearTimeout(rt);
      rt = window.setTimeout(() => layoutAll(false), 90);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(rt);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 드래그 히트 테스트 ──
  const zoneAt = (cx: number, cy: number): ZoneKey | null => {
    for (const z of ZONES) {
      const el = zoneEl(z);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return z;
    }
    return null;
  };

  const clearHighlights = () => {
    ZONES.forEach((z) => zoneEl(z)?.classList.remove("drop"));
    todayPanelRef.current?.classList.remove("drop");
  };

  const highlight = (cx: number, cy: number): DropTarget | null => {
    clearHighlights();
    const tp = todayPanelRef.current;
    if (tp) {
      const r = tp.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        tp.classList.add("drop");
        return "today";
      }
    }
    const z = zoneAt(cx, cy);
    if (z && z !== "unclassified") {
      zoneEl(z)?.classList.add("drop");
    }
    return z;
  };

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    if ((e.target as HTMLElement).closest(".menu-btn")) return;
    // 인라인 편집 중인 카드는 드래그 비활성(입력 조작 보호).
    if (id === editingId || (e.target as HTMLElement).closest(".postit-edit")) return;
    const el = e.currentTarget;
    cbRef.current.onSelect(id);
    let moved = false;
    const r = el.getBoundingClientRect();
    const ox = e.clientX - r.left;
    const oy = e.clientY - r.top;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    el.style.transition = "none";
    el.style.transform = "rotate(0deg)";

    const move = (ev: PointerEvent) => {
      moved = true;
      const o = canvasRef.current!.getBoundingClientRect();
      el.style.left = `${ev.clientX - o.left - ox}px`;
      el.style.top = `${ev.clientY - o.top - oy}px`;
      highlight(ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.classList.remove("dragging");
      el.style.transition = "";
      clearHighlights();
      const sig = signalsRef.current.find((s) => s.id === id);
      const currentZone: ZoneKey = sig ? quadrantToZone(sig.quadrant) : "unclassified";
      if (!moved) {
        layoutZone(currentZone, false);
        return;
      }
      const tp = todayPanelRef.current;
      if (tp) {
        const tr = tp.getBoundingClientRect();
        if (
          ev.clientX >= tr.left &&
          ev.clientX <= tr.right &&
          ev.clientY >= tr.top &&
          ev.clientY <= tr.bottom
        ) {
          cbRef.current.onPromoteToday(id);
          return;
        }
      }
      const z = zoneAt(ev.clientX, ev.clientY);
      if (z && z !== currentZone) {
        cbRef.current.onClassify(id, z);
      } else {
        // 같은 존 또는 빈 곳 → 제자리 복귀.
        layoutZone(currentZone, false);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const inboxCount = signals.filter((s) => zoneOf(s) === "unclassified").length;

  const cells: { zone: ZoneKey; cls: string; dot: string; en: string; ko: string }[] = [
    { zone: "q1", cls: "q1", dot: "var(--color-q1)", en: "Q1 · Do Now", ko: "긴급·중요" },
    { zone: "q2", cls: "q2", dot: "var(--color-q2)", en: "Q2 · Schedule", ko: "안급·중요" },
    { zone: "q3", cls: "q3", dot: "var(--color-q3)", en: "Q3 · Quick", ko: "긴급·안중요" },
    { zone: "q4", cls: "q4", dot: "var(--color-q4)", en: "Q4 · Drop", ko: "안급·안중요" },
  ];

  return (
    <div className="canvas" ref={canvasRef}>
      <div
        className="inbox"
        ref={(el) => {
          cellRefs.current.unclassified = el;
        }}
      >
        <div className="col-label">
          <span className="tag">Inbox</span>
          <span className="ko">미분류</span>
          <span className="count">{inboxCount}</span>
        </div>
        <button
          type="button"
          className="inbox-enrich-all"
          disabled={enrichAllDisabled}
          title="미분류 전체를 AI로 일괄 제안 (Jobs에서 검토·accept — 자동 분류 없음)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEnrichAll();
          }}
        >
          전체 제안 실행
        </button>
      </div>

      <div className="matrix">
        <div className="grid">
          {cells.map((c) => (
            <div
              key={c.zone}
              className={`cell ${c.cls}`}
              ref={(el) => {
                cellRefs.current[c.zone] = el;
              }}
            >
              <div className="clabel">
                <span className="dot" style={{ background: c.dot }} />
                <span className="en">{c.en}</span>
                <span className="ko">{c.ko}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 포스트잇 — canvas 직속 absolute */}
      {signals.map((s) => {
        const zone = zoneOf(s);
        const qClass = zone === "unclassified" ? "" : ` ${zone}`;
        const selCls = s.id === selectedId ? " sel" : "";
        const popCls = poppedIds.has(s.id) ? " pop" : "";
        const sugQ = s.quadrant === "unclassified" ? suggestedQuadrantBadge(s.suggestedQuadrant) : "";
        return (
          <div
            key={s.id}
            className={`postit${qClass}${selCls}${popCls}`}
            ref={(el) => {
              if (el) cardRefs.current.set(s.id, el);
              else cardRefs.current.delete(s.id);
            }}
            onPointerDown={(e) => onCardPointerDown(e, s.id)}
            onMouseDown={() => cbRef.current.onSelect(s.id)}
          >
            {s.kind && (
              <span className={`chip ${kindChipClass(s.kind)}`}>{kindLabel(s.kind)}</span>
            )}
            {s.area && (
              <span className="chip chip-area">{areaLabel(s.area)}</span>
            )}
            {sugQ && (
              <span className="chip chip-q-sug" title="AI 제안 사분면(힌트 — 자동 분류 아님)">
                {sugQ}
              </span>
            )}
            {s.id === editingId ? (
              <TitleEditor
                initial={s.title}
                onCommit={(t) => onEditCommit(s.id, t)}
                onCancel={onEditCancel}
              />
            ) : (
              <div
                className="body"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onEditStart(s.id);
                }}
                title="더블클릭해서 제목 편집"
              >
                {s.title}
              </div>
            )}
            <div className="pdate">{shortDate(s.createdAt)}</div>
            <button
              type="button"
              className="menu-btn"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenMenu(s.id, e.currentTarget);
              }}
            >
              ⋯
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 인라인 제목 편집 결과를 정규화한다(순수 함수 — 단위테스트 대상).
 * 트림 후 빈 값이거나 원본과 동일하면 null(저장 안 함). 그 외 트림된 새 제목.
 */
export function normalizeTitleEdit(next: string, original: string): string | null {
  const trimmed = next.trim();
  if (trimmed === "" || trimmed === original.trim()) return null;
  return trimmed;
}

/**
 * 포스트잇 카드의 인라인 제목 입력. 마운트 시 포커스+전체선택,
 * Enter/blur 저장(정규화는 부모 onEditCommit), Esc 취소.
 */
function TitleEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // commit/cancel 1회만 — Esc 취소가 textarea 언마운트→blur(onCommit)로 되살아나는 것을 차단.
  const settled = useRef(false);
  const commit = (value: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Esc 취소(캡처 단계 — App 셸의 창 숨김 핸들러보다 먼저 가로채야 한다).
  // synthetic stopPropagation은 native window 리스너를 못 막으므로 ProjectPickerModal과 동일 패턴.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      className="postit-edit"
      value={draft}
      rows={2}
      onChange={(e) => setDraft(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit(draft);
        }
      }}
    />
  );
}

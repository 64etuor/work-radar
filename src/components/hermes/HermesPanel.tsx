import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { commands, type HermesPanelState } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

import { clampToViewport, defaultBounds } from "./clampToViewport";
import { DEFAULT_PANEL_STATE, useHermesPanelState } from "./useHermesPanelState";

// 쿼리 키 — useHermesPanelState와 동일해야 한다.
const PANEL_QUERY_KEY = ["hermes-panel-state"] as const;

/**
 * Hermes 플로팅 패널 셸 (Phase A4).
 * - position:fixed, transform:translate3d(x,y,0) — GPU 합성, layout 무관.
 * - 헤더 드래그 + 우하단 리사이즈 그립 (PointerCapture 기반).
 * - "hermes:toggle" Tauri 이벤트 구독 → open 토글 (마운트 1회, stale closure 없음).
 * - Esc 키 닫기 (패널 열림 시에만, input/textarea 포커스 시 제외).
 * - onRestart?: () => void — D4에서 추가, 헤더 재시작 버튼.
 */
export function HermesPanel({
  children,
  onRestart,
}: {
  children: React.ReactNode;
  onRestart?: () => void;
}) {
  const { state, setOpen, setBounds, isLoading } = useHermesPanelState();
  const qc = useQueryClient();

  // Fix #2(초기 배치): x/y/w/h 중 하나라도 null이면 defaultBounds로 초기화.
  // shape-equality 휴리스틱 대신 null 체크 — Option<f64> 설계와 일치.
  useEffect(() => {
    if (isLoading) return;
    if (state.x == null || state.y == null || state.w == null || state.h == null) {
      setBounds(defaultBounds(window.innerWidth, window.innerHeight));
    }
  }, [isLoading, state.x, state.y, state.w, state.h, setBounds]);

  // Fix #1(hermes:toggle): 마운트 1회만 구독 — qc.getQueryData로 최신 상태 읽어
  // stale closure 없이 토글. cancelled 가드로 async 경쟁 방지.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("hermes:toggle", () => {
      const current = qc.getQueryData<HermesPanelState>(PANEL_QUERY_KEY);
      const next: HermesPanelState = {
        ...(current ?? DEFAULT_PANEL_STATE),
        open: !(current?.open ?? false),
      };
      qc.setQueryData(PANEL_QUERY_KEY, next);
      void unwrap(commands.hermesPanelStateSet(next));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [qc]);

  // Fix(Esc gate): 패널 열림 시에만 리스너 등록.
  useEffect(() => {
    if (!state.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.open, setOpen]);

  // Fix #3(resize clamp): 뷰포트 크기 변경 시 패널이 벗어나면 즉시 보정.
  useEffect(() => {
    const onResize = () => {
      if (state.x == null || state.y == null || state.w == null || state.h == null) return;
      const clamped = clampToViewport(
        { x: state.x, y: state.y, w: state.w, h: state.h },
        window.innerWidth,
        window.innerHeight,
      );
      if (
        clamped.x !== state.x ||
        clamped.y !== state.y ||
        clamped.w !== state.w ||
        clamped.h !== state.h
      ) {
        setBounds(clamped);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state.x, state.y, state.w, state.h, setBounds]);

  if (!state.open) return null;

  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const w = state.w ?? 460;
  const h = state.h ?? 600;

  return (
    // TODO(a11y): focus management (trap + restore) — see Phase D
    <div
      role="dialog"
      aria-label="Hermes"
      aria-modal="false"
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: w,
        height: h,
      }}
      className="bg-background border-border fixed z-50 flex flex-col overflow-hidden rounded-lg border shadow-lg"
    >
      {/* ── 헤더 드래그 핸들 ─────────────────────────────────────── */}
      <PanelHeader
        x={x}
        y={y}
        w={w}
        h={h}
        onBoundsChange={setBounds}
        onClose={() => setOpen(false)}
        onRestart={onRestart}
      />

      {/* ── 본문 ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "auto" }}>{children}</div>

      {/* ── 리사이즈 그립 (우하단) ─────────────────────────────── */}
      <ResizeGrip x={x} y={y} w={w} h={h} onBoundsChange={setBounds} />
    </div>
  );
}

// ── 내부 컴포넌트 ──────────────────────────────────────────────────────────

interface BoundsProps {
  x: number;
  y: number;
  w: number;
  h: number;
  onBoundsChange: (b: Partial<{ x: number; y: number; w: number; h: number }>) => void;
}

function PanelHeader({
  x,
  y,
  w,
  h,
  onBoundsChange,
  onClose,
  onRestart,
}: BoundsProps & { onClose: () => void; onRestart?: () => void }) {
  const dragRef = useRef<{
    startPx: number;
    startPy: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startPx: e.clientX, startPy: e.clientY, startX: x, startY: y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startPx;
    const dy = e.clientY - dragRef.current.startPy;
    const next = clampToViewport(
      { x: dragRef.current.startX + dx, y: dragRef.current.startY + dy, w, h },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ x: next.x, y: next.y });
  };

  // Fix(pointercancel): 취소 이벤트도 드래그 상태 정리.
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 12px",
        cursor: "grab",
        userSelect: "none",
        flexShrink: 0,
      }}
      className="border-border border-b"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Hermes</span>
      {onRestart && (
        <Button
          data-no-drag
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onRestart}
          aria-label="새 세션"
          title="새 세션 시작"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        data-no-drag=""
        onClick={onClose}
        aria-label="닫기"
        style={{ padding: "4px", height: "auto" }}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function ResizeGrip({ x, y, w, h, onBoundsChange }: BoundsProps) {
  const resizeRef = useRef<{
    startPx: number;
    startPy: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startPx: e.clientX, startPy: e.clientY, startW: w, startH: h };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const dw = e.clientX - resizeRef.current.startPx;
    const dh = e.clientY - resizeRef.current.startPy;
    const next = clampToViewport(
      { x, y, w: resizeRef.current.startW + dw, h: resizeRef.current.startH + dh },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ w: next.w, h: next.h });
  };

  // Fix(pointercancel): 취소 이벤트도 리사이즈 상태 정리.
  const onPointerUp = () => {
    resizeRef.current = null;
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        right: 0,
        width: 16,
        height: 16,
        cursor: "se-resize",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-hidden
    />
  );
}

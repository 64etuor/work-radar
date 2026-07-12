import { MessageSquarePlus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isComposingEnter } from "@/lib/ime";

import { filterByName, messagePreview, relativeTime } from "./sessionList";
import type { TabId, TabState } from "./useHermesTabs";

const STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  starting: "bg-amber-500",
  ready: "bg-emerald-500",
  error: "bg-destructive",
};

export function HermesSidebar({
  tabs,
  activeTabId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  showResourceWarning,
}: {
  tabs: TabState[];
  activeTabId: TabId | null;
  onSelect: (id: TabId) => void;
  onNew: () => void;
  onDelete: (id: TabId) => void;
  onRename: (id: TabId, name: string) => void;
  showResourceWarning: boolean;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<TabId | null>(null);
  const [draft, setDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = filterByName(tabs, query);

  useEffect(() => {
    if (!editingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingId]);

  const commitRename = (id: TabId) => {
    const name = draft.trim();
    if (name) onRename(id, name);
    setEditingId(null);
  };

  return (
    <div className="bg-background/60 border-border flex w-56 shrink-0 flex-col border-r">
      <div className="flex items-center gap-1.5 p-2">
        <Button
          variant="ghost"
          className="hover:bg-muted/60 h-8 flex-1 justify-start gap-2 px-2"
          onClick={onNew}
        >
          <MessageSquarePlus className="size-4" />
          <span className="text-sm">새 세션</span>
        </Button>
      </div>
      <div className="relative px-2 pb-2">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="세션 검색…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      {showResourceWarning && (
        <p className="text-muted-foreground border-border/60 mx-2 mb-2 rounded border px-2 py-1 text-xs">
          실행 중 세션이 많습니다 — 리소스 사용량이 늘 수 있어요.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-6 text-center text-xs">세션이 없습니다.</p>
        ) : (
          filtered.map((t) => {
            const active = t.id === activeTabId;
            const lastTs = t.messages.length > 0 ? t.messages[t.messages.length - 1].ts : null;
            return (
              <div
                key={t.id}
                className={`group relative mb-0.5 flex flex-col gap-0.5 rounded-md text-left ${
                  active ? "bg-muted" : "hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-1.5 px-2 py-1.5 pr-9">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? STATUS_DOT.idle}`}
                  />
                  {editingId === t.id ? (
                    <input
                      ref={renameInputRef}
                      aria-label="세션 이름"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(t.id)}
                      onKeyDown={(e) => {
                        // 행(role=button)의 keydown 핸들러가 Space/Enter 를 preventDefault 로
                        // 삼키지 않도록 입력 단계에서 전파를 막는다(스페이스 입력 가능).
                        e.stopPropagation();
                        if (isComposingEnter(e)) return; // 한글 조합 확정 Enter는 커밋 아님
                        if (e.key === "Enter") commitRename(t.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-background border-border min-w-0 flex-1 rounded border px-1 text-sm"
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                      onClick={() => onSelect(t.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(t.id);
                        setDraft(t.name);
                      }}
                    >
                      {t.name}
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    className="hover:bg-destructive/10 hover:text-destructive absolute top-1.5 right-2 size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label="세션 영구 삭제"
                    title="세션 영구 삭제"
                    onClick={() => onDelete(t.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <button
                  type="button"
                  className="text-muted-foreground flex items-center justify-between gap-2 px-2 pr-9 pb-1.5 pl-5 text-left"
                  onClick={() => onSelect(t.id)}
                >
                  <span className="min-w-0 truncate text-xs">{messagePreview(t)}</span>
                  {lastTs !== null && (
                    <span className="text-muted-foreground/60 shrink-0 text-xs">
                      {relativeTime(lastTs)}
                    </span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

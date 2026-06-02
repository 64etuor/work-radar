import "./InboxTray.css";

import {
  Archive,
  Bell,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  GitPullRequest,
  MessageSquare,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";

import type { InboxItem } from "@/bindings";
import { groupInboxBySource, inferTargetView, labelSource } from "@/components/inbox/inboxGrouping";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { openExternal } from "@/lib/query";
import {
  useDismissInboxItem,
  useInboxCounts,
  useInboxItems,
  useMarkInboxItemRead,
} from "@/lib/query";
import { useUIStore } from "@/store";

const SEVERITY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  critical: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Bell,
};

/**
 * Inbox 트레이 — 에이전트 바 벨 버튼 Popover로 펼쳐지는 운영 알림 아코디언(뷰 아님).
 * source별 섹션(동적), 각 섹션 접기/펴기. 알림은 요약·딥링크만 — 매트릭스 결정/외부 쓰기 없음
 * (INVARIANT #1). 소스 로스터는 하드코딩하지 않는다(점진 추가 시 섹션 자동 등장).
 */
export function InboxTray({ onClose }: { onClose: () => void }) {
  const items = useInboxItems(null, false);
  const counts = useInboxCounts();
  const markRead = useMarkInboxItemRead();
  const dismiss = useDismissInboxItem();

  const list = useMemo(() => items.data ?? [], [items.data]);
  const groups = useMemo(() => groupInboxBySource(list), [list]);

  // 접힌 섹션 source 키 집합(기본=전부 펼침). 사용자 토글로만 변동.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (source: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  return (
    <div className="inbox-tray" role="dialog" aria-label="Inbox">
      <header className="inbox-tray-head">
        <span className="inbox-tray-title">Inbox</span>
        <div className="inbox-tray-stats" aria-label="Inbox counters">
          <span>읽지 않음 {counts.data?.unread ?? 0}</span>
          {(counts.data?.critical ?? 0) > 0 && (
            <span className="critical">중요 {counts.data?.critical}</span>
          )}
        </div>
        <button type="button" className="inbox-tray-close" aria-label="닫기" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="inbox-tray-body">
        {items.isLoading && <InboxSkeleton />}
        {items.isError && (
          <div className="inbox-tray-empty err">
            Inbox를 불러오지 못했습니다: {(items.error as Error).message}
          </div>
        )}
        {!items.isLoading && !items.isError && groups.length === 0 && (
          <div className="inbox-tray-empty">
            <Sparkles className="size-5" />
            <span>현재 처리할 운영 알림이 없습니다.</span>
          </div>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.source);
          return (
            <section key={group.source} className="inbox-tray-section">
              <button
                type="button"
                className="inbox-tray-section-head"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(group.source)}
              >
                <ChevronDown
                  className={cn("inbox-tray-chevron size-4", isCollapsed && "collapsed")}
                />
                <span className="inbox-tray-section-label">{group.label}</span>
                {group.unread > 0 && (
                  <span className="inbox-tray-section-unread">{group.unread}</span>
                )}
                <span className="inbox-tray-section-count">{group.items.length}</span>
              </button>
              {!isCollapsed && (
                <div className="inbox-tray-list">
                  {group.items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      onRead={() => markRead.mutate(item.id)}
                      onDismiss={() => dismiss.mutate(item.id)}
                      onClose={onClose}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function InboxRow({
  item,
  onRead,
  onDismiss,
  onClose,
}: {
  item: InboxItem;
  onRead: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const { goTo } = useUIStore();
  const Icon = SEVERITY_ICON[item.severity] ?? Bell;
  const targetView = inferTargetView(item);
  const action = parseActionPayload(item.actionPayload);

  return (
    <article className={cn("inbox-row", item.severity, item.unread && "unread")}>
      <div className="inbox-row-icon">
        <Icon className="size-4" />
      </div>
      <div className="inbox-row-main">
        <div className="inbox-row-top">
          <span className="inbox-row-title">{item.title}</span>
          <span className="inbox-row-source">{labelSource(item.source)}</span>
        </div>
        {item.summary ? (
          <p className="inbox-row-summary">{item.summary}</p>
        ) : (
          <p className="inbox-row-summary">{item.body}</p>
        )}
        <div className="inbox-row-meta">
          <span>{item.priority}</span>
          <span>{formatDate(item.updatedAt)}</span>
        </div>
        <div className="inbox-row-actions">
          {targetView && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 rounded-full text-[11px]"
              onClick={() => {
                onClose();
                goTo(targetView);
              }}
            >
              {targetView === "radar" ? (
                <GitPullRequest className="size-3.5" />
              ) : (
                <MessageSquare className="size-3.5" />
              )}
              열기
            </Button>
          )}
          {action?.url && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 rounded-full text-[11px]"
              onClick={() => action.url && void openExternal(action.url)}
            >
              <GitPullRequest className="size-3.5" />
              GitHub
            </Button>
          )}
          {item.unread && (
            <Button
              variant="outline"
              size="sm"
              className="size-7 rounded-full p-0"
              title="읽음"
              aria-label="읽음"
              onClick={onRead}
            >
              <Check className="size-3.5" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="size-7 rounded-full p-0"
            title="dismiss"
            aria-label="dismiss"
            onClick={onDismiss}
          >
            <Archive className="size-3.5" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function parseActionPayload(raw: string | null): { url?: string; prNumber?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      prNumber: typeof parsed.prNumber === "number" ? parsed.prNumber : undefined,
    };
  } catch {
    return null;
  }
}

const INBOX_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string): string {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return INBOX_DATE_FMT.format(date);
}

function InboxSkeleton() {
  return (
    <div className="inbox-skeleton" aria-label="Inbox loading">
      <div />
      <div />
      <div />
    </div>
  );
}

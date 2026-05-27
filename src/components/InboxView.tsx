import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import "./InboxView.css";
import {
  Archive,
  Bell,
  Check,
  CircleAlert,
  CircleCheck,
  Filter,
  GitPullRequest,
  MessageSquare,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import type { InboxItem } from "@/bindings";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/query";
import {
  useDismissInboxItem,
  useInboxCounts,
  useInboxItems,
  useMarkInboxItemRead,
} from "@/lib/query";
import { useUIStore, type View } from "@/store";

const SOURCE_FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: "전체" },
  { key: "pr_radar", label: "PR Radar" },
  { key: "notification", label: "Mac 알림" },
  { key: "agent", label: "Agent" },
  { key: "workflow", label: "Workflow" },
];

const SEVERITY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  critical: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Bell,
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "critical",
  warning: "warning",
  success: "success",
  info: "info",
};

/**
 * Unified Inbox — local operational memory. Alerts can summarize and deep-link,
 * but they do not make matrix decisions or external writes.
 */
export function InboxView() {
  const [source, setSource] = useState<string | null>(null);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const items = useInboxItems(source, includeDismissed);
  const counts = useInboxCounts();
  const markRead = useMarkInboxItemRead();
  const dismiss = useDismissInboxItem();
  const list = useMemo(() => items.data ?? [], [items.data]);

  const grouped = useMemo(() => groupInboxItems(list), [list]);

  return (
    <div className="inbox-view">
      <header className="inbox-head" data-tauri-drag-region>
        <div>
          <span className="inbox-kicker">operations</span>
          <h1>Inbox</h1>
        </div>
        <div className="inbox-stats" aria-label="Inbox counters">
          <Stat label="Unread" value={counts.data?.unread ?? 0} />
          <Stat label="Critical" value={counts.data?.critical ?? 0} tone="critical" />
          <Stat label="Open" value={counts.data?.open ?? 0} />
        </div>
      </header>

      <div className="inbox-toolbar">
        <Filter className="text-wr-subtle size-4" />
        <div className="inbox-filter-row" role="tablist" aria-label="Inbox source filter">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.key ?? "all"}
              type="button"
              className={`inbox-filter${source === f.key ? "active" : ""}`}
              onClick={() => setSource(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="inbox-dismissed">
          <input
            type="checkbox"
            checked={includeDismissed}
            onChange={(e) => setIncludeDismissed(e.target.checked)}
          />
          dismissed 포함
        </label>
      </div>

      <main className="inbox-body">
        {items.isLoading && <InboxSkeleton />}
        {items.isError && (
          <div className="inbox-empty err">
            Inbox를 불러오지 못했습니다: {(items.error as Error).message}
          </div>
        )}
        {!items.isLoading && !items.isError && list.length === 0 && (
          <div className="inbox-empty">
            <Sparkles className="size-5" />
            <span>현재 처리할 운영 알림이 없습니다.</span>
          </div>
        )}
        {grouped.map((group) => (
          <section key={group.key} className="inbox-group">
            <div className="inbox-group-head">
              <span>{group.label}</span>
              <span>{group.items.length}</span>
            </div>
            <div className="inbox-list">
              {group.items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  onRead={() => markRead.mutate(item.id)}
                  onDismiss={() => dismiss.mutate(item.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" }) {
  return (
    <div className={`inbox-stat${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function groupInboxItems(items: InboxItem[]) {
  const order = ["critical", "warning", "info", "success"];
  return order
    .map((severity) => ({
      key: severity,
      label: SEVERITY_LABEL[severity] ?? severity,
      items: items.filter((item) => item.severity === severity),
    }))
    .filter((group) => group.items.length > 0);
}

function InboxRow({
  item,
  onRead,
  onDismiss,
}: {
  item: InboxItem;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const { goTo } = useUIStore();
  const Icon = SEVERITY_ICON[item.severity] ?? Bell;
  const targetView = inferTargetView(item);
  const action = parseActionPayload(item.actionPayload);

  return (
    <article className={`inbox-row ${item.severity}${item.unread ? "unread" : ""}`}>
      <div className="inbox-row-icon">
        <Icon className="size-4" />
      </div>
      <div className="inbox-row-main">
        <div className="inbox-row-top">
          <span className="inbox-row-title">{item.title}</span>
          <span className="inbox-row-source">{labelSource(item)}</span>
        </div>
        {item.summary ? (
          <p className="inbox-row-summary">{item.summary}</p>
        ) : (
          <p className="inbox-row-summary">{item.body}</p>
        )}
        <div className="inbox-row-meta">
          <span>{item.priority}</span>
          <span>{formatDate(item.updatedAt)}</span>
          {item.groupKey && <span>{item.groupKey}</span>}
        </div>
      </div>
      <div className="inbox-row-actions">
        {targetView && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1 rounded-full text-[11px]"
            onClick={() => goTo(targetView)}
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

function labelSource(item: InboxItem): string {
  if (item.source === "pr_radar") return "PR Radar";
  if (item.source === "notification") return "Mac 알림";
  if (item.source === "agent") return "Agent";
  return item.source;
}

function inferTargetView(item: InboxItem): View | null {
  if (item.relatedEntityType === "pr" || item.source === "pr_radar") return "radar";
  if (item.relatedEntityType === "agent" || item.source === "agent") return "jobs";
  if (item.relatedEntityType === "worktree") return "worktree";
  if (item.source === "notification") return null;
  return "today";
}

function formatDate(value: string): string {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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

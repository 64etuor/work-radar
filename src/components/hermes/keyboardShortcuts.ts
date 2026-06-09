import type { TabId, TabState } from "./useHermesTabs";

export type HermesShortcutAction =
  | { type: "new-tab" }
  | { type: "hide-window" }
  | { type: "select-tab"; tabId: TabId };

type HermesShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
};

export function isEditableShortcutTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export function resolveHermesShortcut(
  event: HermesShortcutEvent,
  opts: {
    panelOpen: boolean;
    tabs: readonly TabState[];
  },
): HermesShortcutAction | null {
  if (!opts.panelOpen) return null;
  if (!(event.metaKey || event.ctrlKey)) return null;
  if (event.altKey || event.shiftKey) return null;

  const key = event.key.toLowerCase();
  if (key === "n") return { type: "new-tab" };
  if (key === "w") return { type: "hide-window" };

  if (/^[1-9]$/.test(event.key) && !isEditableShortcutTarget(event.target)) {
    const tab = opts.tabs[Number(event.key) - 1];
    return tab ? { type: "select-tab", tabId: tab.id } : null;
  }

  return null;
}

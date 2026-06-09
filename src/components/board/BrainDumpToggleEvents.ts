import { isOverlayOpen } from "@/components/ui/overlay-stack";

const GLOBAL_ENTER_BLOCKER_SELECTOR =
  'input, textarea, select, button, a[href], [role="button"], [role="menuitem"], [role="option"], [contenteditable=""], [contenteditable="true"]';

export function shouldOpenBrainDumpFromGlobalEnter(
  e: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented"
  >,
  activeElement: Element | null,
  overlayOpen = isOverlayOpen(),
): boolean {
  if (e.key !== "Enter") return false;
  if (e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (overlayOpen) return false;
  if (!activeElement) return true;
  return !activeElement.closest(GLOBAL_ENTER_BLOCKER_SELECTOR);
}

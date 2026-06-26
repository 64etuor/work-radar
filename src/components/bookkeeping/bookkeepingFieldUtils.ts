import { IpcError } from "@/lib/query";
import { useToastStore } from "@/lib/toast";

export function splitCsv(value: string) {
  return value.split(",").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function appendCsvToken(value: string, token: string) {
  const items = splitCsv(value);
  if (!items.includes(token)) items.push(token);
  return items.join(", ");
}

export function nullableText(value: string) {
  return value.trim() || null;
}

export function pushMutationError(scope: string, error: unknown) {
  const store = useToastStore.getState();
  if (error instanceof IpcError) {
    store.pushError(scope, error.app);
  } else {
    store.pushError(scope, error instanceof Error ? error.message : String(error));
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

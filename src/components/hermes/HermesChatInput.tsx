import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { HermesSlashMenu } from "./HermesSlashMenu";
import type { AcpCommand } from "./types";

function isImagePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
}

interface Props {
  onSend: (text: string, images: string[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  commandsList: AcpCommand[];
}

export function detectSlashToken(
  text: string,
  caret: number,
): { active: boolean; query: string; start: number } {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, caret);
  return token.startsWith("/")
    ? { active: true, query: token.slice(1), start }
    : { active: false, query: "", start: -1 };
}

export function HermesChatInput({ onSend, onCancel, disabled, isStreaming, commandsList }: Props) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [attachments, setAttachments] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const slash = useMemo(() => detectSlashToken(text, caret), [text, caret]);
  const filtered = useMemo(
    () =>
      slash.active
        ? commandsList.filter((c) => c.name.toLowerCase().startsWith(slash.query.toLowerCase()))
        : [],
    [commandsList, slash.active, slash.query],
  );
  const menuOpen = slash.active && filtered.length > 0;

  const pickSlash = useCallback(
    (cmd: AcpCommand) => {
      const before = text.slice(0, slash.start);
      const after = text.slice(caret);
      const inserted = `/${cmd.name} `;
      const nextText = before + inserted + after;
      setText(nextText);
      const newCaret = (before + inserted).length;
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(newCaret, newCaret);
        setCaret(newCaret);
      });
      setActiveIdx(0);
    },
    [text, caret, slash.start],
  );

  const saveBytes = useCallback(async (bytes: Uint8Array, ext: string): Promise<string | null> => {
    try {
      const r = await commands.hermesSavePastedImage(Array.from(bytes), ext);
      if (r.status !== "ok") return null;
      return r.data;
    } catch {
      return null;
    }
  }, []);

  const onPaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const ab = await blob.arrayBuffer();
          const ext = item.type.split("/")[1] ?? "png";
          const path = await saveBytes(new Uint8Array(ab), ext);
          if (path) setAttachments((a) => [...a, path]);
        }
      }
    },
    [saveBytes],
  );

  // Tauri 2 기본 설정에서는 OS WebView 가 drag-drop 을 DOM 보다 먼저 가로채므로
  // HTML onDrop 이 동작하지 않는다. 윈도우 레벨 이벤트에 직접 등록.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const paths = (event.payload as { type: "drop"; paths: string[] }).paths;
          const imagePaths = paths.filter(isImagePath);
          if (imagePaths.length > 0) {
            setAttachments((a) => [...a, ...imagePaths]);
          }
        })
        .then((u) => {
          if (cancelled) u();
          else unlisten = u;
        }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const pickFile = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    const paths = Array.isArray(result) ? result : result ? [result] : [];
    if (paths.length > 0) setAttachments((a) => [...a, ...paths]);
  }, []);

  const submit = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
    setActiveIdx(0);
  }, [text, attachments, onSend]);

  return (
    <div className="relative px-4 py-4">
      {attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((p, i) => (
            <div key={p + i} className="group relative">
              {isImagePath(p) ? (
                <img
                  src={convertFileSrc(p)}
                  alt=""
                  title={p.split("/").pop()}
                  className="border-border/60 size-9 rounded-full border object-cover"
                />
              ) : (
                <div
                  title={p.split("/").pop()}
                  className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-full"
                >
                  <Paperclip className="size-4" />
                </div>
              )}
              <button
                type="button"
                onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                aria-label="첨부 제거"
                className="bg-foreground text-background absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative">
        {menuOpen && (
          <HermesSlashMenu
            items={filtered}
            activeIdx={activeIdx}
            onPick={pickSlash}
            onHover={setActiveIdx}
          />
        )}
        {/* Integrated input shell */}
        <div className="border-border/60 bg-background focus-within:border-foreground/40 relative rounded-full border transition-colors">
          <Button
            data-no-drag
            type="button"
            variant="ghost"
            className="bg-muted text-muted-foreground hover:bg-muted/70 absolute top-1/2 left-2 size-9 -translate-y-1/2 rounded-full p-0"
            onClick={pickFile}
            disabled={disabled}
            aria-label="이미지 첨부"
          >
            <Paperclip className="size-4" />
          </Button>
          <Textarea
            ref={taRef}
            className="max-h-[160px] min-h-[44px] resize-none border-0 bg-transparent py-2.5 pr-14 pl-14 focus-visible:ring-0 focus-visible:ring-offset-0"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setActiveIdx(0);
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const sel = filtered[activeIdx];
                  if (sel) pickSlash(sel);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCaret(-1);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            placeholder="메시지 · `/` 명령 · 이미지 paste/drop"
            disabled={disabled || isStreaming}
          />
          {isStreaming ? (
            <Button
              className="absolute top-1/2 right-2 size-9 -translate-y-1/2 rounded-full p-0"
              variant="destructive"
              onClick={onCancel}
              aria-label="중단"
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button
              className="absolute top-1/2 right-2 size-9 -translate-y-1/2 rounded-full p-0"
              onClick={submit}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              aria-label="전송"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

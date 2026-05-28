import { Paperclip, Send, Square, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { HermesSlashMenu } from "./HermesSlashMenu";
import type { AcpCommand } from "./types";

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

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      for (const file of Array.from(e.dataTransfer.files)) {
        if (!file.type.startsWith("image/")) continue;
        const ab = await file.arrayBuffer();
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
        const path = await saveBytes(new Uint8Array(ab), ext);
        if (path) setAttachments((a) => [...a, path]);
      }
    },
    [saveBytes],
  );

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
    <div
      className="border-border/50 relative border-t px-3 py-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {isStreaming && (
        <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs">
          <span className="bg-foreground/60 size-1.5 animate-pulse rounded-full" />
          Hermes가 작성 중…
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((p, i) => (
            <span
              key={p + i}
              className="bg-muted inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
            >
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[200px] truncate">{p.split("/").pop()}</span>
              <button
                type="button"
                onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                aria-label="remove attachment"
                className="hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
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
        <div className="border-border/60 bg-background focus-within:border-foreground/40 relative rounded-2xl border transition-colors">
          <Button
            data-no-drag
            type="button"
            variant="ghost"
            className="hover:bg-muted/60 absolute bottom-2 left-2 h-7 w-7 p-0"
            onClick={pickFile}
            disabled={disabled}
            aria-label="이미지 첨부"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
          <Textarea
            ref={taRef}
            className="max-h-[160px] min-h-[44px] resize-none border-0 bg-transparent py-2.5 pr-12 pl-10 focus-visible:ring-0 focus-visible:ring-offset-0"
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
              className="absolute right-2 bottom-2 h-7 w-7 rounded-full p-0"
              variant="destructive"
              onClick={onCancel}
              aria-label="중단"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              className="absolute right-2 bottom-2 h-7 w-7 rounded-full p-0"
              onClick={submit}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              aria-label="전송"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

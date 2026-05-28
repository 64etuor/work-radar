import { Send } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { HermesSlashMenu } from "./HermesSlashMenu";
import type { AcpCommand } from "./types";

interface Props {
  onSend: (text: string, images: string[]) => void;
  disabled?: boolean;
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

export function HermesChatInput({ onSend, disabled, commandsList }: Props) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
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

  const submit = useCallback(() => {
    if (!text.trim()) return;
    onSend(text, []);
    setText("");
    setActiveIdx(0);
  }, [text, onSend]);

  return (
    <div className="relative flex items-end gap-2 border-t p-3">
      {menuOpen && (
        <HermesSlashMenu
          items={filtered}
          activeIdx={activeIdx}
          onPick={pickSlash}
          onHover={setActiveIdx}
        />
      )}
      <Textarea
        ref={taRef}
        className="max-h-[200px] min-h-[40px] flex-1 resize-none"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setActiveIdx(0);
        }}
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
        placeholder="메시지 (/ 입력 시 명령 목록)"
        disabled={disabled}
      />
      <Button
        size="sm"
        className="h-9 w-9 shrink-0 p-0"
        onClick={submit}
        disabled={disabled || !text.trim()}
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}

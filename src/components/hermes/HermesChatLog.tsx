import { Check, Loader2, Sparkles, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import type { HermesMessage, ToolCallSummary } from "./types";

interface Props {
  messages: HermesMessage[];
}

function ToolCallPill({ t }: { t: ToolCallSummary }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    t.status === "completed" ? (
      <Check className="text-foreground/60 size-3" />
    ) : t.status === "failed" ? (
      <X className="text-destructive size-3" />
    ) : (
      <Loader2 className="size-3 animate-spin" />
    );

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60 inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors"
      >
        <Wrench className="size-3 shrink-0" />
        <span className="font-mono">{t.kind ?? t.title}</span>
        {statusIcon}
      </button>
      {expanded && (
        <div className="bg-muted/30 text-muted-foreground mt-1 max-w-full overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
          {t.title}
          {t.status ? `\nstatus: ${t.status}` : ""}
          {t.id ? `\nid: ${t.id}` : ""}
        </div>
      )}
    </div>
  );
}

export function HermesChatLog({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="border-border/60 flex size-9 items-center justify-center rounded-full border">
            <Sparkles className="size-4" />
          </div>
          <p className="text-foreground/80 text-sm">Hermes에게 무엇이든</p>
          <p className="text-xs">
            텍스트, 이미지, <span className="font-mono">/</span> 명령
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-w-0 flex-1 overflow-auto px-4 py-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="flex flex-col">
        {messages.map((m, idx) => {
          const prev = messages[idx - 1];
          const turnChanged = prev && prev.role !== m.role;
          return (
            <div
              key={m.id}
              className={cn(
                "text-sm",
                m.role === "user" && "flex justify-end",
                turnChanged ? "mt-4" : idx > 0 ? "mt-1.5" : "",
              )}
            >
              {m.role === "user" && (
                <div className="bg-muted/60 inline-block max-w-[80%] rounded-2xl px-3.5 py-2 text-left [overflow-wrap:anywhere] break-words">
                  <p className="break-words whitespace-pre-wrap">{m.text}</p>
                  {m.images.length > 0 && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {m.images.length} image{m.images.length > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              )}
              {m.role === "assistant" && (
                <div className="max-w-full min-w-0">
                  {m.toolCalls.length > 0 && (
                    <div className="mb-1.5 flex flex-col gap-1.5">
                      {m.toolCalls.map((t, i) => (
                        <ToolCallPill key={t.id ?? i} t={t} />
                      ))}
                    </div>
                  )}
                  <div className="[&_code]:bg-muted [&_pre]:bg-muted [&_a]:text-foreground/80 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground text-sm leading-relaxed [overflow-wrap:anywhere] break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:px-1 [&_code]:text-xs [&_h1]:text-base [&_h1]:font-medium [&_h2]:text-sm [&_h2]:font-medium [&_h3]:text-sm [&_h3]:font-medium [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.chunks.join("")}</ReactMarkdown>
                    {!m.done && (
                      <span className="ml-0.5 inline-block animate-pulse opacity-50">▍</span>
                    )}
                  </div>
                </div>
              )}
              {m.role === "system" && (
                <p
                  className={cn(
                    "py-1 text-center text-xs italic",
                    m.level === "error" && "text-destructive",
                    m.level === "warn" && "text-amber-600",
                    m.level === "info" && "text-muted-foreground",
                  )}
                >
                  {m.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div ref={endRef} />
    </div>
  );
}

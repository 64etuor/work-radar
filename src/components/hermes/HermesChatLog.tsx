import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import type { HermesMessage } from "./types";

interface Props {
  messages: HermesMessage[];
}

export function HermesChatLog({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div
      className="min-w-0 flex-1 space-y-3 overflow-auto px-4 py-3"
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {messages.length === 0 && (
        <p className="text-muted-foreground py-8 text-center text-xs">
          Hermes에게 무엇이든 물어보세요…
        </p>
      )}
      {messages.map((m) => (
        <div key={m.id} className={cn("text-sm", m.role === "user" && "text-right")}>
          {m.role === "user" && (
            <div className="bg-accent text-accent-foreground inline-block max-w-[85%] rounded-md px-3 py-2 text-left [overflow-wrap:anywhere] break-words">
              <p className="break-words whitespace-pre-wrap">{m.text}</p>
              {m.images.length > 0 && (
                <p className="text-muted-foreground mt-1 text-xs">
                  📎 {m.images.length} image{m.images.length > 1 ? "s" : ""}
                </p>
              )}
            </div>
          )}
          {m.role === "assistant" && (
            <div className="bg-muted max-w-full min-w-0 rounded-md px-3 py-2">
              {m.toolCalls.map((t, i) => (
                <details key={t.id ?? i} className="mb-1 text-xs">
                  <summary className="text-muted-foreground cursor-pointer">
                    ⚙ {t.title}
                    {t.status ? ` (${t.status})` : ""}
                  </summary>
                </details>
              ))}
              <div className="[&_code]:bg-muted [&_pre]:bg-muted [&_a]:text-foreground/80 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground text-sm leading-relaxed [overflow-wrap:anywhere] break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:px-1 [&_code]:text-xs [&_h1]:text-base [&_h1]:font-medium [&_h2]:text-sm [&_h2]:font-medium [&_h3]:text-sm [&_h3]:font-medium [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.chunks.join("")}</ReactMarkdown>
              </div>
              {!m.done && <span className="ml-1 inline-block animate-pulse">▍</span>}
            </div>
          )}
          {m.role === "system" && (
            <p
              className={cn(
                "text-xs",
                m.level === "error" && "text-destructive",
                m.level === "warn" && "text-amber-500",
                m.level === "info" && "text-muted-foreground",
              )}
            >
              {m.text}
            </p>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

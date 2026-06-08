import { type DotLottie, DotLottieReact } from "@lottiefiles/dotlottie-react";
import { Check, Loader2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import hermesOrbUrl from "@/assets/hermes-orb.json?url";
import { cn } from "@/lib/utils";

import { AskUserCard } from "./AskUserCard";
import type { HermesMessage, ToolCallSummary } from "./types";
import { useTypewriter } from "./useTypewriter";

interface Props {
  messages: HermesMessage[];
  onRespond: (requestId: string, optionId: string, cancelled: boolean) => void;
}

/** Tool pill title with typewriter reveal. */
function ToolPillTitle({ title }: { title: string }) {
  const revealed = useTypewriter(title);
  // min-w-0 + truncate: 긴 툴 호출 제목이 pill 을 채팅 폭 밖으로 늘리지 않게 말줄임.
  return <span className="min-w-0 truncate font-mono">{revealed}</span>;
}

function ToolCallPill({ t }: { t: ToolCallSummary }) {
  const [expanded, setExpanded] = useState(false);

  const inProgress = !t.status || t.status === "in_progress" || t.status === "pending";
  const statusIcon = inProgress ? (
    <Loader2 className="size-3 animate-spin" />
  ) : t.status === "completed" ? (
    <Check className="text-foreground/60 size-3" />
  ) : (
    <X className="text-destructive size-3" />
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60 inline-flex max-w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors"
      >
        <Wrench className="size-3 shrink-0" />
        <ToolPillTitle title={t.title || t.kind || "tool"} />
        <span className="inline-flex shrink-0">{statusIcon}</span>
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

/** Assistant message bubble with typewriter text reveal. */
function AssistantBubble({
  m,
  instant,
}: {
  m: Extract<HermesMessage, { role: "assistant" }>;
  instant?: boolean;
}) {
  const fullText = m.chunks.join("");
  const revealed = useTypewriter(fullText, { instant });
  const isTyping = revealed.length < fullText.length;

  return (
    <div className="max-w-full min-w-0 text-left">
      {m.toolCalls.length > 0 && (
        // items-start로 도구 칩을 항상 좌측 정렬(어떤 부모 flex/grid 조합에서도 가운데 쏠리지 않게).
        <div className="mb-1.5 flex flex-col items-start gap-1.5 text-left">
          {m.toolCalls.map((t, i) => (
            <ToolCallPill key={t.id ?? i} t={t} />
          ))}
        </div>
      )}
      <div className="[&_code]:bg-muted [&_pre]:bg-muted [&_a]:text-foreground/80 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground text-sm leading-relaxed [overflow-wrap:anywhere] break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:px-1 [&_code]:text-xs [&_h1]:text-base [&_h1]:font-medium [&_h2]:text-sm [&_h2]:font-medium [&_h3]:text-sm [&_h3]:font-medium [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{revealed}</ReactMarkdown>
        {(!m.done || isTyping) && (
          <span data-cursor className="ml-0.5 inline-block animate-pulse opacity-50">
            ▍
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 빈 상태 마크 — Lottie를 1회 재생 후 "Hermes" 워드마크가 블러인으로 페이드.
 * complete 이벤트는 DotLottie ref(setDotLottie) 의 addEventListener("complete") 로 구독.
 * `exiting=true` 일 때 워드마크에 .is-exiting 추가 → 220ms 펄스+페이드아웃.
 */
function EmptyHermesMark({ exiting }: { exiting: boolean }) {
  const [done, setDone] = useState(false);
  const [dot, setDot] = useState<DotLottie | null>(null);

  useEffect(() => {
    if (!dot) return;
    const onComplete = () => setDone(true);
    dot.addEventListener("complete", onComplete);
    return () => dot.removeEventListener("complete", onComplete);
  }, [dot]);

  if (done) {
    return (
      <span
        className={cn(
          "hermes-wordmark text-foreground font-mono text-[44px] leading-none font-medium tracking-tight",
          exiting && "is-exiting",
        )}
      >
        Hermes
      </span>
    );
  }

  return (
    <DotLottieReact
      src={hermesOrbUrl}
      autoplay
      loop={false}
      dotLottieRefCallback={setDot}
      className="size-32"
      aria-hidden
    />
  );
}

/** 워드마크 펄스+페이드아웃 지속 시간(ms) — motion.css `.hermes-wordmark.is-exiting` 와 일치. */
const EMPTY_EXIT_MS = 220;

export function HermesChatLog({ messages, onRespond }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // 0 → >0 전환 시에만 워드마크 펄스아웃 후 채팅 마운트.
  const [exiting, setExiting] = useState(false);
  // 초기값 = "지금 비었는지". 메시지가 이미 있는 채로 mount(세션 복원/전환)되면 false라
  // 거짓 exit 트리거를 막는다. (버그: 복원 세션에서 빈 워드마크가 떠 내용이 안 나옴 —
  // 초기값 true + StrictMode 이중 effect로 exiting 이 true에 고착됐다.)
  const prevEmpty = useRef(messages.length === 0);
  useEffect(() => {
    const isEmpty = messages.length === 0;
    if (prevEmpty.current && !isEmpty) setExiting(true);
    prevEmpty.current = isEmpty;
  }, [messages.length]);
  // exit 펄스아웃 타이머는 exiting 에만 의존 — 그 사이 메시지 길이가 바뀌어도(스트리밍 중
  // assistant 버블 추가 등) messages.length effect의 cleanup이 타이머를 지워 exiting 이
  // 영구히 true로 고착되는 일을 막는다.
  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(() => setExiting(false), EMPTY_EXIT_MS);
    return () => clearTimeout(t);
  }, [exiting]);

  // 메시지 변경 + 마운트(패널 재오픈) 시 최하단 추적. 첫 스크롤(마운트·재오픈)은 instant로
  // 즉시 최하단에 붙이고(껐다 켜면 바로 마지막 메시지), 이후 스트리밍 갱신은 smooth.
  // rAF로 마크다운/코드블록 레이아웃 완료 후 스크롤을 보장한다.
  const initialScrollRef = useRef(true);
  useEffect(() => {
    if (!followRef.current) return;
    const behavior: ScrollBehavior = initialScrollRef.current ? "auto" : "smooth";
    initialScrollRef.current = false;
    const id = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior, block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  if (messages.length === 0 || exiting) {
    return (
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <EmptyHermesMark exiting={exiting} />
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-w-0 flex-1 overflow-auto p-4"
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
              {/* 이미 완료된 메시지(m.done)는 즉시 풀텍스트로 — 패널 재오픈 시 타이프라이터 재생 방지.
               * 스트리밍 중인 마지막 메시지만 자연스러운 리빌. */}
              {m.role === "assistant" && <AssistantBubble m={m} instant={m.done} />}
              {m.role === "system" && (
                <p
                  className={cn(
                    "py-1 text-xs italic",
                    m.level === "error" && "text-destructive",
                    m.level === "warn" && "text-amber-600",
                    m.level === "info" && "text-muted-foreground",
                  )}
                >
                  {m.text}
                </p>
              )}
              {m.role === "ask" && (
                <AskUserCard
                  message={m}
                  onRespond={(optionId, cancelled) => onRespond(m.requestId, optionId, cancelled)}
                />
              )}
            </div>
          );
        })}
      </div>
      <div ref={endRef} />
    </div>
  );
}

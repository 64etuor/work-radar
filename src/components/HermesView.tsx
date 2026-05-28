import "./HermesView.css";

import { RefreshCw, Send, X } from "lucide-react";
import { useState } from "react";

import type { HermesMessage } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import {
  useFetchHermesMessages,
  useHermesBridgeStatus,
  useHermesMessages,
  useSendHermesMessage,
} from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * Hermes 제어 surface (Phase 20 #15). 외부 Hermes 에이전트를 Telegram Bot API류 브리지로 제어하는
 * 채팅형 뷰 — 명령 입력(전송) + 송·수신 메시지 목록. 수신은 bounded 단발 fetch(무한 polling 아님,
 * #5) — 사용자가 "수신" 버튼으로 cadence를 정한다. 미설정이면 graceful degrade(설정 안내).
 * 봇 토큰은 keychain(Rust)에만 — 이 surface는 토큰을 절대 다루지 않는다.
 *
 * `onClose` 주어지면 **모달(채팅창) 모드**: 헤더의 닫기(X), 설정 이동 시 모달 먼저 닫음,
 * 창 드래그 영역 비활성. 없으면 풀 페이지 모드.
 */
export function HermesView({ onClose }: { onClose?: () => void } = {}) {
  const { goTo } = useUIStore();
  const openSettings = () => {
    onClose?.();
    goTo("settings", "open");
  };
  const status = useHermesBridgeStatus();
  const messages = useHermesMessages();
  const send = useSendHermesMessage();
  const fetch = useFetchHermesMessages();

  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const configured = status.data?.configured ?? false;
  const list = messages.data ?? [];

  const submit = () => {
    if (send.isPending) return;
    const t = text.trim();
    if (!t) return;
    send.mutate(t, {
      onSuccess: () => setText(""),
      onError: (e) => setNote(`전송 실패: ${(e as Error).message}`),
    });
  };

  const receive = () => {
    if (fetch.isPending) return;
    setNote(null);
    fetch.mutate(undefined, {
      onSuccess: (r) => setNote(r.received > 0 ? `${r.received}건 수신` : "새 메시지 없음"),
      onError: (e) => setNote(`수신 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="hermes">
      <header className="hm-head" {...(onClose ? {} : { "data-tauri-drag-region": "" })}>
        {onClose && (
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onClose} aria-label="닫기">
            <X className="size-4" />
          </Button>
        )}
        <span className="hm-title">Hermes</span>
        <span className={configured ? "hm-status on" : "hm-status"}>
          {configured ? "● 연결됨" : "○ 미설정"}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5 rounded-full"
          onClick={receive}
          disabled={!configured || fetch.isPending}
          title="새 메시지 단발 수신 (bounded)"
        >
          <RefreshCw className={cn("size-4", fetch.isPending && "animate-spin")} />
          수신
        </Button>
      </header>

      {!configured ? (
        <div className="hm-empty">
          Hermes 브리지가 설정되지 않았습니다. 설정 → Hermes 브리지에서 봇 토큰과 chat_id를
          입력하세요.
          <Button variant="outline" size="sm" className="rounded-full" onClick={openSettings}>
            설정 열기
          </Button>
        </div>
      ) : (
        <div className="hm-scroll">
          {messages.isError && (
            <div className="hm-note err">
              메시지를 불러오지 못했습니다: {(messages.error as Error).message}
            </div>
          )}
          {list.length === 0 ? (
            <div className="hm-empty">
              아직 메시지가 없습니다 — 아래에서 Hermes에게 명령을 보내세요.
            </div>
          ) : (
            <div className="hm-list">
              {list.map((m) => (
                <MessageRow key={m.id} msg={m} />
              ))}
            </div>
          )}
        </div>
      )}

      {note && <div className="hm-note">{note}</div>}

      <div className="hm-compose">
        <Input
          className="flex-1"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={configured ? "Hermes에게 명령 보내기…" : "먼저 브리지를 설정하세요"}
          disabled={!configured || send.isPending}
          aria-label="Hermes 명령 입력"
        />
        <Button
          className="gap-1.5 rounded-full"
          onClick={submit}
          disabled={!configured || send.isPending || !text.trim()}
          title="명령 전송 (Enter)"
        >
          <Send className="size-4" />
          {send.isPending ? "전송 중…" : "전송"}
        </Button>
      </div>
    </div>
  );
}

/** 송신(우측)·수신(좌측) 한 줄. direction으로 정렬/색을 가른다. */
function MessageRow({ msg }: { msg: HermesMessage }) {
  const sent = msg.direction === "sent";
  return (
    <div className={cn("hm-msg", sent ? "sent" : "recv")}>
      <div className="hm-bubble">
        <span className="hm-text">{msg.text}</span>
        <span className="hm-meta">
          {sent ? "→ Hermes" : "← Hermes"} · {msg.createdAt}
        </span>
      </div>
    </div>
  );
}

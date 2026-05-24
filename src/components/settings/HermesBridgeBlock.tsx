import { useState } from "react";

import {
  useDetectHermesChatId,
  useDisconnectHermes,
  useHermesBridgeStatus,
  useSetHermesBridge,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "./kit";

/**
 * Hermes 메신저 브리지 설정 (Phase 20 #15). 외부 Hermes 에이전트를 Telegram Bot API류로 제어하기
 * 위한 봇 토큰 + chat_id를 설정한다. 봇 토큰은 keychain(Rust)에만 저장되고 본문은 절대 다시
 * 노출되지 않는다(INVARIANT) — 입력란은 항상 비어 있고 상태는 configured 여부만 보여준다.
 * 앱 레벨 단일 브리지(외부 Hermes 하나)라 프로젝트와 무관한 전역 블록이다(NotificationSettings 선례).
 */
export function HermesBridgeBlock({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const status = useHermesBridgeStatus();
  const save = useSetHermesBridge();
  const disconnect = useDisconnectHermes();
  const detect = useDetectHermesChatId();

  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");

  const configured = status.data?.configured ?? false;

  const submit = () => {
    if (save.isPending) return;
    const t = botToken.trim();
    const c = chatId.trim();
    if (!t || !c) {
      onToast("봇 토큰과 chat_id를 모두 입력하세요");
      return;
    }
    save.mutate(
      { botToken: t, chatId: c },
      {
        onSuccess: () => {
          setBotToken("");
          setChatId("");
          onToast("Hermes 브리지 설정됨");
        },
        onError: (e) => onToast(`설정 실패: ${(e as Error).message}`),
      },
    );
  };

  const cut = () => {
    if (disconnect.isPending) return;
    disconnect.mutate(undefined, {
      onSuccess: () => onToast("Hermes 브리지 연결 해제됨"),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Hermes 브리지</span>
        <StatusDot on={configured}>
          {configured ? "연결됨" : "미설정"}
          {status.data?.chatId ? ` · chat ${status.data.chatId}` : ""}
        </StatusDot>
      </div>

      <div className="flex flex-col gap-2">
        <Input
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={configured ? "봇 토큰 (재설정 시 입력)" : "봇 토큰"}
          autoComplete="off"
          aria-label="Hermes 봇 토큰"
        />
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="chat_id (예: 123456789)"
            autoComplete="off"
            aria-label="Hermes chat_id"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={detect.isPending}
            title="getUpdates에서 본인(사람) chat_id를 자동 감지합니다"
            onClick={() => {
              detect.mutate(botToken.trim() || null, {
                onSuccess: (result) => {
                  setChatId(result.chatId);
                  onToast(`감지됨: ${result.label} (${result.chatId})`);
                },
                onError: (e) => onToast(`감지 실패: ${(e as Error).message}`),
              });
            }}
          >
            {detect.isPending ? "감지 중…" : "내 chat id 감지"}
          </Button>
          <Button
            size="sm"
            className="shrink-0"
            onClick={submit}
            disabled={save.isPending}
            title="봇 토큰은 keychain에만 저장됩니다"
          >
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
          {configured && (
            <Button
              variant="destructiveOutline"
              size="sm"
              className="shrink-0"
              onClick={cut}
              disabled={disconnect.isPending}
              title="봇 토큰 삭제 + chat_id 해제"
            >
              {disconnect.isPending ? "해제 중…" : "연결 해제"}
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        외부 Hermes 에이전트를 Telegram Bot API류로 제어합니다 — work-radar가 명령을 보내고
        응답을 받습니다(Hermes 뷰). 봇 토큰은 OS keychain에만 저장되고 절대 화면/DB로 노출되지
        않습니다. 수신은 bounded 단발(무한 polling 아님)입니다. 미설정이어도 앱 코어는 정상입니다.
      </p>

      {status.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(status.error)}</p>
      )}
      {save.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(save.error)}</p>
      )}
    </div>
  );
}

import { Mail, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCancelGmailOauth,
  useDisconnectGmail,
  useGmailStatus,
  useSetGmailOauthClient,
  useStartGmailOauth,
} from "@/lib/query";

import { googleAccountOauthViewState } from "./googleAccountUx";
import { StatusDot } from "./SettingsKit";

/**
 * 프로젝트별 Gmail 연결 (send-only — `gmail.send` 스코프). Google 계정 connect UI를 미러링하되
 * 캘린더 목록·ping 없음(Gmail은 발송 전용, 검증은 백엔드 refresh-ping).
 * INVARIANT: client_id/secret은 **로컬 입력 상태에만** 잠시 머물고 저장(IPC) 직후 비운다.
 * refresh_token/secret은 keychain에만. 미연결/네트워크 실패는 기능 비활성(graceful degrade).
 */
export function GmailBlock({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const status = useGmailStatus(projectId);
  const setClient = useSetGmailOauthClient();
  const startOauth = useStartGmailOauth();
  const cancelOauth = useCancelGmailOauth();
  const disconnect = useDisconnectGmail();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthAttempt, setOauthAttempt] = useState<{ id: number; startedAt: number } | null>(null);
  const [oauthElapsedMs, setOauthElapsedMs] = useState(0);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const currentAttempt = useRef<number | null>(null);
  const nextAttempt = useRef(1);

  const hasClient = status.data?.hasClient ?? false;
  const connected = status.data?.connected ?? false;
  const oauthWaiting = oauthAttempt !== null;
  const oauthState = googleAccountOauthViewState({
    hasClient,
    connected,
    waiting: oauthWaiting,
    elapsedMs: oauthElapsedMs,
  });

  useEffect(() => {
    if (!oauthAttempt) {
      return;
    }
    const tick = () => setOauthElapsedMs(Date.now() - oauthAttempt.startedAt);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [oauthAttempt]);

  const saveClient = () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret || setClient.isPending) return;
    setClient.mutate(
      { projectId, clientId: id, clientSecret: secret },
      {
        onSuccess: () => {
          setClientId("");
          setClientSecret("");
          onToast("Gmail OAuth client 저장됨 (keychain) — Gmail을 연결하세요");
        },
      },
    );
  };

  const connect = () => {
    if (oauthWaiting || !hasClient) return;
    const attemptId = nextAttempt.current++;
    currentAttempt.current = attemptId;
    setOauthError(null);
    setOauthAttempt({ id: attemptId, startedAt: Date.now() });
    startOauth.reset();
    startOauth.mutate(projectId, {
      onSuccess: () => {
        if (currentAttempt.current !== attemptId) return;
        onToast("Gmail 연결됨");
      },
      onError: (e) => {
        if (currentAttempt.current !== attemptId) return;
        setOauthError((e as Error).message);
      },
      onSettled: () => {
        if (currentAttempt.current !== attemptId) return;
        currentAttempt.current = null;
        setOauthAttempt(null);
        setOauthElapsedMs(0);
      },
    });
  };

  const cancelWaiting = () => {
    if (!oauthWaiting) return;
    currentAttempt.current = null;
    setOauthAttempt(null);
    setOauthElapsedMs(0);
    setOauthError(null);
    startOauth.reset();
    cancelOauth.mutate(projectId, {
      onSuccess: () => onToast("Gmail 동의 대기 취소됨"),
    });
  };

  const remove = () => {
    disconnect.mutate(projectId, {
      onSuccess: () => onToast("Gmail 연결 해제됨"),
    });
  };

  return (
    <div className="border-border rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Mail className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">Gmail</span>
          <StatusDot on={connected}>
            {connected ? "연결됨" : hasClient ? "client 입력됨" : "미설정"}
          </StatusDot>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={connect}
            disabled={oauthState.primaryDisabled}
            title={hasClient ? "브라우저로 Gmail 동의 진행" : "먼저 client를 저장하세요"}
          >
            {oauthState.primaryLabel}
          </Button>
          {(connected || hasClient) && (
            <Button
              variant="destructiveOutline"
              size="sm"
              onClick={remove}
              disabled={disconnect.isPending}
            >
              연결 해제
            </Button>
          )}
        </div>
      </div>

      {/* OAuth client(client_id/secret) — Google Cloud Console > Desktop OAuth client */}
      <div className="border-border flex flex-col gap-2 border-t px-4 py-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            type="password"
            autoComplete="off"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={hasClient ? "client_id 교체…" : "client_id"}
            className="font-mono"
          />
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveClient()}
              placeholder={hasClient ? "client_secret 교체…" : "client_secret"}
              className="font-mono"
            />
            <Button
              size="sm"
              className="shrink-0"
              onClick={saveClient}
              disabled={!clientId.trim() || !clientSecret.trim() || setClient.isPending}
            >
              저장
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Google Cloud Console에서 <b>Desktop</b> OAuth client를 만들고 <code>gmail.send</code>{" "}
          범위를 활성화하세요. 캘린더 연결과 <b>별개 client</b>일 수 있습니다(스코프가 다름). 이전에
          다른 권한으로 연결했다면 <b>"다시 연결"</b>로 재동의하세요.
        </p>
      </div>

      {oauthState.showWaitingPanel && (
        <div
          className={`border-border flex items-start justify-between gap-3 border-t px-4 py-2.5 text-xs ${
            oauthState.waitingTone === "stale"
              ? "text-[color:var(--destructive)]"
              : "text-muted-foreground"
          }`}
        >
          <div className="min-w-0">
            <div className="text-foreground font-medium">
              Gmail 동의 대기 중 · {oauthState.elapsedLabel}
            </div>
            <div className="mt-0.5">{oauthState.waitingMessage}</div>
          </div>
          {oauthState.showCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={cancelWaiting}
              disabled={cancelOauth.isPending}
              title="현재 OAuth 대기를 취소하고 다시 시도할 수 있게 합니다"
            >
              <X className="size-3" />
              {cancelOauth.isPending ? "취소 중" : "취소"}
            </Button>
          )}
        </div>
      )}
      {(oauthError || startOauth.isError) && !oauthWaiting && (
        <div className="border-border border-t px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {oauthError ?? String(startOauth.error)}
        </div>
      )}
      {cancelOauth.isError && (
        <div className="border-border border-t px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {String(cancelOauth.error)}
        </div>
      )}
    </div>
  );
}

import { CircleUserRound, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCancelGoogleAccountOauth,
  useDisconnectGoogleAccount,
  useGoogleAccountStatus,
  usePingGoogleAccount,
  useSetGoogleAccountOauthClient,
  useStartGoogleAccountOauth,
} from "@/lib/query";

import { CalendarPicker } from "./CalendarPicker";
import { googleAccountOauthViewState } from "./googleAccountUx";
import { StatusDot } from "./SettingsKit";
import { useOauthAttempt } from "./useOauthAttempt";

/**
 * 프로젝트별 Google 계정 연결 (Calendar read+write + Gmail 발송 — 한 동의로 통합).
 * INVARIANT: client_id/secret은 **로컬 입력 상태에만** 잠시 머물고 저장(IPC) 직후 비운다.
 * refresh_token/secret은 keychain에만. 미연결/네트워크 실패는 기능 비활성(graceful degrade).
 */
export function GoogleAccountBlock({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const status = useGoogleAccountStatus(projectId);
  const setClient = useSetGoogleAccountOauthClient();
  const startOauth = useStartGoogleAccountOauth();
  const cancelOauth = useCancelGoogleAccountOauth();
  const disconnect = useDisconnectGoogleAccount();
  const ping = usePingGoogleAccount();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const {
    oauthAttempt,
    oauthElapsedMs,
    oauthError,
    setOauthAttempt,
    setOauthElapsedMs,
    setOauthError,
    beginAttempt,
    isCurrentAttempt,
    endAttempt,
  } = useOauthAttempt();

  const hasClient = status.data?.hasClient ?? false;
  const connected = status.data?.connected ?? false;
  const oauthWaiting = oauthAttempt !== null;
  const oauthState = googleAccountOauthViewState({
    hasClient,
    connected,
    waiting: oauthWaiting,
    elapsedMs: oauthElapsedMs,
  });

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
          onToast("Google OAuth client 저장됨 (keychain) — Google 계정을 연결하세요");
        },
      },
    );
  };

  const connect = () => {
    if (oauthWaiting || !hasClient) return;
    const attemptId = beginAttempt();
    setOauthError(null);
    setOauthAttempt({ id: attemptId, startedAt: Date.now() });
    startOauth.reset();
    startOauth.mutate(projectId, {
      onSuccess: () => {
        if (!isCurrentAttempt(attemptId)) return;
        onToast("Google 계정 연결됨");
      },
      onError: (e) => {
        if (!isCurrentAttempt(attemptId)) return;
        setOauthError((e as Error).message);
      },
      onSettled: () => {
        if (!isCurrentAttempt(attemptId)) return;
        endAttempt();
        setOauthAttempt(null);
        setOauthElapsedMs(0);
      },
    });
  };

  const cancelWaiting = () => {
    if (!oauthWaiting) return;
    endAttempt();
    setOauthAttempt(null);
    setOauthElapsedMs(0);
    setOauthError(null);
    startOauth.reset();
    cancelOauth.mutate(projectId, {
      onSuccess: () => onToast("Google 계정 동의 대기 취소됨"),
    });
  };

  const remove = () => {
    disconnect.mutate(projectId, {
      onSuccess: () => onToast("Google 계정 연결 해제됨"),
    });
  };

  const pingResult = ping.data;

  return (
    <div className="border-border rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <CircleUserRound className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">Google 계정</span>
          <StatusDot on={connected}>
            {connected ? "계정 연결됨" : hasClient ? "client 입력됨" : "미설정"}
          </StatusDot>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={connect}
            disabled={oauthState.primaryDisabled}
            title={hasClient ? "브라우저로 Google 계정 동의 진행" : "먼저 client를 저장하세요"}
          >
            {oauthState.primaryLabel}
          </Button>
          {connected && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => ping.mutate(projectId)}
              disabled={ping.isPending}
              title="refresh로 연결 검증"
            >
              {ping.isPending ? "확인 중…" : "Test 연결"}
            </Button>
          )}
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
              Google 계정 동의 대기 중 · {oauthState.elapsedLabel}
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
      {ping.isError && (
        <div className="border-border border-t px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {String(ping.error)}
        </div>
      )}
      {pingResult && (
        <div
          className={`border-border border-t px-4 py-2.5 text-xs ${
            pingResult.ok ? "text-[color:var(--success)]" : "text-[color:var(--destructive)]"
          }`}
        >
          {pingResult.ok ? "✓ " : "✗ "}
          {pingResult.detail}
        </div>
      )}

      {connected && <CalendarPicker projectId={projectId} onToast={onToast} />}
    </div>
  );
}

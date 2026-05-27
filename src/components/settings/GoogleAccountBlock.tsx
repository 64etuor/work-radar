import { useEffect, useMemo, useRef, useState } from "react";
import { CircleUserRound, Check, X } from "lucide-react";

import {
  useCancelGoogleAccountOauth,
  useDisconnectGoogleAccount,
  useGoogleAccountStatus,
  useGoogleCalendars,
  usePingGoogleAccount,
  useSetGoogleAccountOauthClient,
  useSetSelectedCalendars,
  useStartGoogleAccountOauth,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionLabel, StatusDot } from "./SettingsKit";
import { googleAccountOauthViewState } from "./googleAccountUx";

/**
 * 프로젝트별 Google 계정 연결 (현재 Calendar read+write — 캘린더 목록·이벤트 생성).
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
          onToast("Google OAuth client 저장됨 (keychain) — Google 계정을 연결하세요");
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
        onToast("Google 계정 연결됨");
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
        <p className="text-muted-foreground text-xs leading-relaxed">
          Google Cloud Console에서 <b>Desktop</b> OAuth client를 만들어 입력하세요. 캘린더
          목록·이벤트 생성을 위해 현재는 <code>calendar</code>(읽기+쓰기) 범위를 씁니다.
          Gmail·Drive·Sheets 기능이 추가되면 같은 Google 계정 연결에서 필요한 권한을 더 요청할 수
          있습니다. 읽기 전용이나 이전 권한으로 연결했었다면 <b>"다시 연결"</b>로 재동의하세요.
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

/** 연결된 프로젝트의 calendarList 다중 선택. 선택 목록만 로컬 SQLite SSOT. */
function CalendarPicker({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const calendars = useGoogleCalendars(projectId, true);
  const save = useSetSelectedCalendars();
  const [draftChecked, setDraftChecked] = useState<Set<string> | null>(null);
  const savedChecked = useMemo(
    () => new Set(calendars.data?.filter((c) => c.selected).map((c) => c.id) ?? []),
    [calendars.data],
  );
  const checked = draftChecked ?? savedChecked;

  const toggle = (id: string) => {
    setDraftChecked((prev) => {
      const next = new Set(prev ?? checked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (save.isPending || !calendars.data) return;
    const selected = calendars.data
      .filter((c) => checked.has(c.id))
      .map((c) => ({ id: c.id, summary: c.summary }));
    save.mutate(
      { projectId, calendars: selected },
      {
        onSuccess: () => {
          setDraftChecked(null);
          onToast(
            selected.length > 0 ? `캘린더 ${selected.length}개 선택 저장` : "캘린더 선택 비움",
          );
        },
      },
    );
  };

  return (
    <div className="border-border flex flex-col gap-2 border-t px-4 py-3">
      <SectionLabel>포함할 캘린더</SectionLabel>
      {calendars.isLoading && <div className="text-muted-foreground text-sm">불러오는 중…</div>}
      {calendars.isError &&
        (() => {
          const msg = String(calendars.error);
          const isReconnect = msg.includes("재연결 필요");
          return (
            <div className="text-xs text-[color:var(--destructive)]">
              {isReconnect ? "재연결 필요 — Google 계정을 다시 연결하세요" : msg}
            </div>
          );
        })()}
      {calendars.data && calendars.data.length === 0 && (
        <div className="text-muted-foreground text-sm">캘린더가 없습니다.</div>
      )}
      {calendars.data?.map((c) => {
        const on = checked.has(c.id);
        return (
          <label key={c.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input type="checkbox" checked={on} onChange={() => toggle(c.id)} className="sr-only" />
            <span
              className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                on ? "border-primary bg-primary text-primary-foreground" : "border-input"
              }`}
            >
              {on && <Check className="size-3" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.summary}</span>
            {c.primary && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
                기본
              </span>
            )}
          </label>
        );
      })}
      {calendars.data && calendars.data.length > 0 && (
        <Button size="sm" className="mt-1 self-start" onClick={submit} disabled={save.isPending}>
          {save.isPending ? "저장 중…" : "선택 저장"}
        </Button>
      )}
    </div>
  );
}

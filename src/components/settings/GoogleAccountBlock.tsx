import { Check, CircleUserRound, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import {
  useCancelGoogleAccountOauth,
  useDisconnectGoogleAccount,
  useGoogleAccountStatus,
  useGoogleCalendars,
  usePingGoogleAccount,
  useProjects,
  useSetGoogleAccountOauthClient,
  useSetProjectDefaultWriteCalendar,
  useSetSelectedCalendars,
  useStartGoogleAccountOauth,
} from "@/lib/query";

import { googleAccountOauthViewState } from "./googleAccountUx";
import { SectionLabel, StatusDot } from "./SettingsKit";

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
  const projects = useProjects();
  const setDefault = useSetProjectDefaultWriteCalendar();
  // 타임라인 기본 캘린더(프로젝트별) — 포함된 캘린더 중 하나만 지정 가능.
  const defaultCalendarId =
    projects.data?.find((p) => p.id === projectId)?.defaultWriteCalendarId ?? null;
  const pickDefault = (calendarId: string | null) =>
    setDefault.mutate({ projectId, calendarId }, { onError: (e) => onToast(String(e)) });
  // optimistic: 체크박스 토글 즉시 mutate. 서버 응답이 늦어도 즉시 반응 보이도록
  // 직전 토글 결과를 로컬에 잠깐 가지고 있다가 서버 데이터가 따라잡으면 비운다.
  const [pendingChecked, setPendingChecked] = useState<Set<string> | null>(null);
  const savedChecked = useMemo(
    () => new Set(calendars.data?.filter((c) => c.selected).map((c) => c.id) ?? []),
    [calendars.data],
  );
  const checked = pendingChecked ?? savedChecked;

  const toggle = (id: string) => {
    if (!calendars.data) return;
    const next = new Set(checked);
    const removing = next.has(id);
    if (removing) next.delete(id);
    else next.add(id);
    setPendingChecked(next);
    // 포함 해제하는 캘린더가 현재 기본이면 기본도 해제 — 포함 안 된 캘린더는 기본일 수 없다.
    if (removing && defaultCalendarId === id) pickDefault(null);
    const selected = calendars.data
      .filter((c) => next.has(c.id))
      .map((c) => ({ id: c.id, summary: c.summary }));
    save.mutate(
      { projectId, calendars: selected },
      {
        onSuccess: () => {
          setPendingChecked(null);
        },
        onError: (e) => {
          setPendingChecked(null);
          onToast(String(e));
        },
      },
    );
  };

  return (
    <div className="border-border flex flex-col gap-2 border-t px-4 py-3">
      <SectionLabel>포함할 캘린더</SectionLabel>
      <p className="text-muted-foreground -mt-1 text-xs leading-5">
        별(
        <Star className="inline size-3 align-[-1px]" />
        )을 누르면 타임라인에 카드를 놓을 때 자동으로 쓸 기본 캘린더가 됩니다 — 포함된 캘린더만
        지정할 수 있습니다.
      </p>
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
        const isDefault = on && defaultCalendarId === c.id;
        return (
          <div key={c.id} className="flex items-center gap-2.5 text-sm">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(c.id)}
                className="sr-only"
                aria-label={`${c.summary} 포함`}
              />
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                  on ? "border-primary bg-primary text-primary-foreground" : "border-input"
                }`}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.summary}</span>
              {c.primary && (
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">
                  Google 기본
                </span>
              )}
            </label>
            {on && (
              <button
                type="button"
                onClick={() => pickDefault(isDefault ? null : c.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
                  isDefault
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
                title={
                  isDefault
                    ? "타임라인 기본 캘린더 — 해제하려면 클릭"
                    : "타임라인에 놓을 때 쓸 기본 캘린더로 지정"
                }
                aria-pressed={isDefault}
                aria-label={`${c.summary} 타임라인 기본 캘린더`}
              >
                <Star className={cn("size-3", isDefault && "fill-current")} />
                {isDefault ? "기본" : "기본으로"}
              </button>
            )}
          </div>
        );
      })}
      {calendars.data && calendars.data.length > 0 && save.isPending && (
        <span className="text-muted-foreground mt-1 self-start text-xs">저장 중…</span>
      )}
    </div>
  );
}

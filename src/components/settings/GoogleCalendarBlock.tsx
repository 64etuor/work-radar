import { useEffect, useState } from "react";
import { Calendar, Check } from "lucide-react";

import {
  useDisconnectGoogle,
  useGoogleCalendarStatus,
  useGoogleCalendars,
  usePingGoogleCalendar,
  useSetGoogleOauthClient,
  useSetSelectedCalendars,
  useStartGoogleOauth,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionLabel, StatusDot } from "./SettingsKit";

/**
 * 프로젝트별 Google Calendar 연결 (read+write — 캘린더 목록·이벤트 생성).
 * INVARIANT: client_id/secret은 **로컬 입력 상태에만** 잠시 머물고 저장(IPC) 직후 비운다.
 * refresh_token/secret은 keychain에만. 미연결/네트워크 실패는 기능 비활성(graceful degrade).
 */
export function GoogleCalendarBlock({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const status = useGoogleCalendarStatus(projectId);
  const setClient = useSetGoogleOauthClient();
  const startOauth = useStartGoogleOauth();
  const disconnect = useDisconnectGoogle();
  const ping = usePingGoogleCalendar();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const hasClient = status.data?.hasClient ?? false;
  const connected = status.data?.connected ?? false;

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
          onToast("OAuth client 저장됨 (keychain) — '연결'을 진행하세요");
        },
      },
    );
  };

  const connect = () => {
    if (startOauth.isPending) return;
    startOauth.mutate(projectId, {
      onSuccess: () => onToast("Google Calendar 연결됨"),
    });
  };

  const remove = () => {
    disconnect.mutate(projectId, {
      onSuccess: () => onToast("Google Calendar 연결 해제됨"),
    });
  };

  const pingResult = ping.data;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Calendar className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Google Calendar</span>
          <StatusDot on={connected}>
            {connected ? "연결됨" : hasClient ? "client 입력됨" : "미설정"}
          </StatusDot>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={connect}
            disabled={!hasClient || startOauth.isPending}
            title={hasClient ? "브라우저로 Google 동의 진행" : "먼저 client를 저장하세요"}
          >
            {startOauth.isPending ? "동의 대기 중…" : connected ? "다시 연결" : "연결"}
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
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          Google Cloud Console에서 <b>Desktop</b> OAuth client를 만들어 입력하세요. 캘린더
          목록·이벤트 생성을 위해 <code>calendar</code>(읽기+쓰기) 범위를 씁니다. 읽기 전용으로
          연결했었다면 <b>"다시 연결"</b>로 재동의하세요.
        </p>
      </div>

      {startOauth.isPending && (
        <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          브라우저에서 Google 동의를 완료하세요…
        </div>
      )}
      {startOauth.isError && (
        <div className="border-t border-border px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {String(startOauth.error)}
        </div>
      )}
      {ping.isError && (
        <div className="border-t border-border px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {String(ping.error)}
        </div>
      )}
      {pingResult && (
        <div
          className={`border-t border-border px-4 py-2.5 text-xs ${
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
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (calendars.data) {
      setChecked(new Set(calendars.data.filter((c) => c.selected).map((c) => c.id)));
    }
  }, [calendars.data]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
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
        onSuccess: () =>
          onToast(
            selected.length > 0 ? `캘린더 ${selected.length}개 선택 저장` : "캘린더 선택 비움",
          ),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <SectionLabel>포함할 캘린더</SectionLabel>
      {calendars.isLoading && <div className="text-sm text-muted-foreground">불러오는 중…</div>}
      {calendars.isError &&
        (() => {
          const msg = String(calendars.error);
          const isReconnect = msg.includes("재연결 필요");
          return (
            <div className="text-xs text-[color:var(--destructive)]">
              {isReconnect ? "재연결 필요 — Google Calendar를 다시 연결하세요" : msg}
            </div>
          );
        })()}
      {calendars.data && calendars.data.length === 0 && (
        <div className="text-sm text-muted-foreground">캘린더가 없습니다.</div>
      )}
      {calendars.data?.map((c) => {
        const on = checked.has(c.id);
        return (
          <label key={c.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={on}
              onChange={() => toggle(c.id)}
              className="sr-only"
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
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
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

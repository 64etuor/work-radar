import { useEffect, useState } from "react";

import {
  useDisconnectGoogle,
  useGoogleCalendarStatus,
  useGoogleCalendars,
  usePingGoogleCalendar,
  useSetGoogleOauthClient,
  useSetSelectedCalendars,
  useStartGoogleOauth,
} from "@/lib/query";

/**
 * 프로젝트별 Google Calendar 연결 (Phase 10a, read 레일).
 * INVARIANT: client_id/secret은 **로컬 입력 상태에만** 잠시 머물고 저장(IPC) 직후 비운다.
 * refresh_token/secret은 keychain에만 — 캐시/렌더러 어디에도 본문을 두지 않는다. 상태는 boolean만.
 * 미연결/client 미입력/네트워크 실패는 기능 비활성(graceful degrade) — 앱 코어는 정상.
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
    <div className="st-token">
      <div className="st-token-head">
        <span className="st-token-lbl">Google Calendar</span>
        <span className={connected ? "st-status on" : "st-status"}>
          {connected ? "● 연결됨" : hasClient ? "○ client 입력됨" : "○ 미설정"}
        </span>
      </div>

      {/* OAuth client(client_id/secret) — Google Cloud Console > Desktop OAuth client */}
      <div className="st-token-row">
        <input
          className="st-input"
          type="password"
          autoComplete="off"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={hasClient ? "client_id 교체…" : "client_id"}
        />
      </div>
      <div className="st-token-row">
        <input
          className="st-input"
          type="password"
          autoComplete="off"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveClient()}
          placeholder={hasClient ? "client_secret 교체…" : "client_secret"}
        />
        <button
          type="button"
          className="st-btn sm"
          onClick={saveClient}
          disabled={!clientId.trim() || !clientSecret.trim() || setClient.isPending}
        >
          저장
        </button>
      </div>

      <div className="st-token-row">
        <button
          type="button"
          className="st-btn sm"
          onClick={connect}
          disabled={!hasClient || startOauth.isPending}
          title={hasClient ? "브라우저로 Google 동의 진행" : "먼저 client를 저장하세요"}
        >
          {startOauth.isPending
            ? "동의 대기 중…"
            : connected
              ? "다시 연결"
              : "연결"}
        </button>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={() => ping.mutate(projectId)}
          disabled={!connected || ping.isPending}
          title={connected ? "refresh로 연결 검증" : "먼저 연결하세요"}
        >
          {ping.isPending ? "확인 중…" : "Test 연결"}
        </button>
        {(connected || hasClient) && (
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={remove}
            disabled={disconnect.isPending}
          >
            연결 해제
          </button>
        )}
      </div>

      <div className="st-hint">
        Google Cloud Console에서 <b>Desktop</b> OAuth client를 만들어 client_id/secret을
        입력하세요. 이벤트 생성을 위해 <code>calendar.events</code>(읽기+쓰기) 범위를 씁니다 —
        기존에 읽기 전용으로 연결했다면 <b>"다시 연결"</b>로 쓰기 권한을 재동의하세요. 보통
        "테스트 사용자"로 동의 가능(앱 게시/검증 불요).
      </div>

      {startOauth.isPending && (
        <div className="st-ping">브라우저에서 Google 동의를 완료하세요…</div>
      )}
      {startOauth.isError && (
        <div className="st-err">{String(startOauth.error)}</div>
      )}
      {ping.isError && <div className="st-err">{String(ping.error)}</div>}
      {pingResult && (
        <div className={pingResult.ok ? "st-ping ok" : "st-ping fail"}>
          {pingResult.ok ? "✓ " : "✗ "}
          {pingResult.detail}
        </div>
      )}

      {connected && <CalendarPicker projectId={projectId} onToast={onToast} />}
    </div>
  );
}

/**
 * 연결된 프로젝트의 calendarList 다중 선택 (Phase 10b). 포함할 캘린더를 체크해 저장하면
 * fetch_calendar_events가 그 캘린더들의 오늘 이벤트만 병합한다. 선택 목록만 로컬 SQLite SSOT.
 */
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

  // 로드된 selected 플래그로 체크 상태를 시드(한 번).
  useEffect(() => {
    if (calendars.data) {
      setChecked(
        new Set(calendars.data.filter((c) => c.selected).map((c) => c.id)),
      );
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
            selected.length > 0
              ? `캘린더 ${selected.length}개 선택 저장`
              : "캘린더 선택 비움",
          ),
      },
    );
  };

  return (
    <div className="st-cal">
      <div className="st-subhead">포함할 캘린더</div>
      {calendars.isLoading && <div className="st-empty">불러오는 중…</div>}
      {calendars.isError && (
        <div className="st-err">{String(calendars.error)}</div>
      )}
      {calendars.data && calendars.data.length === 0 && (
        <div className="st-empty">캘린더가 없습니다.</div>
      )}
      {calendars.data?.map((c) => (
        <label key={c.id} className="st-cal-item">
          <input
            type="checkbox"
            checked={checked.has(c.id)}
            onChange={() => toggle(c.id)}
          />
          <span className="st-cal-name">{c.summary}</span>
          {c.primary && <span className="st-cal-tag">기본</span>}
        </label>
      ))}
      {calendars.data && calendars.data.length > 0 && (
        <button
          type="button"
          className="st-btn sm"
          onClick={submit}
          disabled={save.isPending}
        >
          {save.isPending ? "저장 중…" : "선택 저장"}
        </button>
      )}
    </div>
  );
}

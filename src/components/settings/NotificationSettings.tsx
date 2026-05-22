import { useState } from "react";

import {
  useNotificationPermission,
  useRequestNotificationPermission,
  useScheduleTestNotification,
} from "@/lib/query";

/**
 * 알림 / 트레이 설정 (Phase 13). 알림 권한 상태 + 권한 요청 + 테스트 알림 버튼.
 * 테스트 알림은 즉시 발사가 아니라 백그라운드 스케줄러 큐에 행을 INSERT한다 — 스파인이
 * bounded tick(30초 간격)에서 발사한다. 권한이 없어도 앱 코어는 정상(graceful degrade).
 * 프로젝트와 무관한 전역 설정이라 SettingsView 하단 단일 블록으로 둔다.
 */
export function NotificationSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const perm = useNotificationPermission();
  const request = useRequestNotificationPermission();
  const scheduleTest = useScheduleTestNotification();
  const [seconds, setSeconds] = useState(5);

  const granted = perm.data?.granted ?? false;
  const state = perm.data?.state ?? "unknown";
  const statusLabel =
    state === "granted"
      ? "● 허용됨"
      : state === "denied"
        ? "○ 거부됨"
        : state === "prompt"
          ? "○ 미결정"
          : "○ 알 수 없음";

  const ask = () => {
    if (request.isPending) return;
    request.mutate(undefined, {
      onSuccess: (p) =>
        onToast(p.granted ? "알림 권한 허용됨" : "알림 권한이 허용되지 않음"),
    });
  };

  const fireTest = () => {
    if (scheduleTest.isPending) return;
    scheduleTest.mutate(Math.max(0, seconds), {
      onSuccess: () =>
        onToast(
          `${seconds}초 뒤 테스트 알림 예약됨 — 스케줄러가 발사합니다`,
        ),
    });
  };

  return (
    <div className="st-token">
      <div className="st-token-head">
        <span className="st-token-lbl">알림 / 트레이</span>
        <span className={granted ? "st-status on" : "st-status"}>
          {statusLabel}
        </span>
      </div>

      <div className="st-token-row">
        <button
          type="button"
          className="st-btn sm"
          onClick={ask}
          disabled={request.isPending || granted}
          title={granted ? "이미 허용됨" : "OS 알림 권한 요청"}
        >
          {request.isPending
            ? "요청 중…"
            : granted
              ? "권한 허용됨"
              : "알림 권한 요청"}
        </button>
        <input
          className="st-input"
          type="number"
          min={0}
          max={3600}
          value={seconds}
          onChange={(e) => setSeconds(Number(e.target.value) || 0)}
          style={{ width: 72 }}
          aria-label="테스트 알림 지연(초)"
        />
        <span className="st-status">초 뒤</span>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={fireTest}
          disabled={scheduleTest.isPending}
          title="백그라운드 스케줄러가 발사할 테스트 알림 예약"
        >
          {scheduleTest.isPending ? "예약 중…" : "테스트 알림"}
        </button>
      </div>

      <div className="st-hint">
        창을 닫아도 앱은 트레이/메뉴바에 상주합니다 — 트레이 아이콘에서 보기/숨기기/종료.
        백그라운드 스케줄러가 예약된 알림(루틴·CI 등)을 발사합니다. 권한이 없으면 알림만
        건너뛰고 나머지 기능은 정상 동작합니다.
      </div>

      {request.isError && <div className="st-err">{String(request.error)}</div>}
      {scheduleTest.isError && (
        <div className="st-err">{String(scheduleTest.error)}</div>
      )}
    </div>
  );
}

import { useState } from "react";

import type { PrRadarSettings } from "@/bindings";
import {
  useNotificationPermission,
  usePrRadarSettings,
  useRequestNotificationPermission,
  useScheduleTestNotification,
  useSetPrRadarSettings,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "./SettingsKit";

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
  const prSettings = usePrRadarSettings();
  const savePrSettings = useSetPrRadarSettings();
  const [seconds, setSeconds] = useState(5);

  const granted = perm.data?.granted ?? false;
  const state = perm.data?.state ?? "unknown";
  const statusLabel =
    state === "granted"
      ? "허용됨"
      : state === "denied"
        ? "거부됨"
        : state === "prompt"
          ? "미결정"
          : "알 수 없음";

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

  const updatePrSetting = (patch: Partial<PrRadarSettings>) => {
    const current = prSettings.data;
    if (!current || savePrSettings.isPending) return;
    savePrSettings.mutate(
      { ...current, ...patch },
      { onSuccess: () => onToast("PR Radar 알림 설정 저장됨") },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">알림 / 트레이</span>
        <StatusDot on={granted}>{statusLabel}</StatusDot>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={granted ? "secondary" : "default"}
          onClick={ask}
          disabled={request.isPending || granted}
          title={granted ? "이미 허용됨" : "OS 알림 권한 요청"}
        >
          {request.isPending
            ? "요청 중…"
            : granted
              ? "권한 허용됨"
              : "알림 권한 요청"}
        </Button>
        <Input
          type="number"
          min={0}
          max={3600}
          value={seconds}
          onChange={(e) => setSeconds(Number(e.target.value) || 0)}
          className="w-[72px]"
          aria-label="테스트 알림 지연(초)"
        />
        <span className="text-xs text-muted-foreground">초 뒤</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={fireTest}
          disabled={scheduleTest.isPending}
          title="백그라운드 스케줄러가 발사할 테스트 알림 예약"
        >
          {scheduleTest.isPending ? "예약 중…" : "테스트 알림"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        창을 닫아도 앱은 트레이/메뉴바에 상주합니다 — 트레이 아이콘에서 보기/숨기기/종료.
        백그라운드 스케줄러가 예약된 알림(루틴·CI 등)을 발사합니다. 권한이 없으면 알림만
        건너뛰고 나머지 기능은 정상 동작합니다.
      </p>

      <div className="mt-2 border-t border-border pt-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm font-medium">PR Radar Inbox rules</span>
          <StatusDot on={!!prSettings.data}>
            {prSettings.data ? "활성" : "로드 중"}
          </StatusDot>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Poll interval (minutes)
            <Input
              type="number"
              min={1}
              max={120}
              value={prSettings.data?.pollIntervalMinutes ?? 10}
              onChange={(e) =>
                updatePrSetting({
                  pollIntervalMinutes: Number(e.target.value) || 10,
                })
              }
              aria-label="PR Radar polling interval minutes"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Comment alert threshold
            <Input
              type="number"
              min={1}
              max={250}
              value={prSettings.data?.commentAlertThreshold ?? 10}
              onChange={(e) =>
                updatePrSetting({
                  commentAlertThreshold: Number(e.target.value) || 10,
                })
              }
              aria-label="PR Radar comment threshold"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={prSettings.data?.conflictAlertsEnabled ?? true}
              onChange={(e) =>
                updatePrSetting({ conflictAlertsEnabled: e.target.checked })
              }
            />
            conflict pattern을 critical Inbox alert로 저장
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={prSettings.data?.aiAutoAnalysisEnabled ?? true}
              onChange={(e) =>
                updatePrSetting({ aiAutoAnalysisEnabled: e.target.checked })
              }
            />
            threshold 초과 항목을 AI 분석 후보로 표시
          </label>
        </div>
      </div>

      {request.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(request.error)}</p>
      )}
      {scheduleTest.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(scheduleTest.error)}</p>
      )}
      {savePrSettings.isError && (
        <p className="text-xs text-[color:var(--destructive)]">
          PR Radar 설정 저장 실패: {String(savePrSettings.error)}
        </p>
      )}
    </div>
  );
}

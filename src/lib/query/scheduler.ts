import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands, type NotificationPermission } from "@/bindings";

/** 알림 권한 상태(granted/denied/prompt/unknown). 발사 가능 여부는 granted일 때만. */
export function useNotificationPermission() {
  return useQuery<NotificationPermission>({
    queryKey: ["notificationPermission"],
    queryFn: () => unwrap(commands.notificationPermission()),
    staleTime: 30_000,
  });
}

/** 알림 권한 요청(미결정 시 OS 프롬프트). 결과를 캐시에 반영. */
export function useRequestNotificationPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.requestNotificationPermission()),
    onSuccess: (perm) =>
      qc.setQueryData(["notificationPermission"], perm),
  });
}

/**
 * 테스트 알림을 seconds_from_now 뒤로 예약(스파인 시연용). 발사는 백그라운드 스케줄러가
 * bounded tick에서 수행한다 — 즉시 발사가 아니라 큐 INSERT다.
 */
export function useScheduleTestNotification() {
  return useMutation({
    mutationFn: (secondsFromNow: number) =>
      unwrap(commands.scheduleTestNotification(secondsFromNow)),
  });
}

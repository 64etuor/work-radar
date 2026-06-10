const MARQUEE_SPEED_MIN = 1;
const MARQUEE_SPEED_MAX = 9;

export function clampMarqueeSpeed(value: number): number {
  return Math.max(MARQUEE_SPEED_MIN, Math.min(MARQUEE_SPEED_MAX, Math.trunc(value)));
}

export function marqueeSpeedToSeconds(speed: number): number {
  const bySpeed: Record<number, number> = {
    1: 180,
    2: 150,
    3: 120,
    4: 90,
    5: 60,
    6: 45,
    7: 35,
    8: 28,
    9: 20,
  };
  return bySpeed[clampMarqueeSpeed(speed)] ?? 60;
}

export function secondsToMarqueeSpeed(seconds: number): number {
  if (seconds >= 165) return 1;
  if (seconds >= 135) return 2;
  if (seconds >= 105) return 3;
  if (seconds >= 75) return 4;
  if (seconds >= 53) return 5;
  if (seconds >= 40) return 6;
  if (seconds >= 32) return 7;
  if (seconds >= 24) return 8;
  return 9;
}

export { MARQUEE_SPEED_MAX, MARQUEE_SPEED_MIN };

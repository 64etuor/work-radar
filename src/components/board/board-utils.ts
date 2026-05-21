import type { AreaTag, Kind, Quadrant } from "@/bindings";

/** 캔버스 존 키 (프로토타입 단축형). */
export type ZoneKey = "unclassified" | "q1" | "q2" | "q3" | "q4";

export const ZONES: ZoneKey[] = ["unclassified", "q1", "q2", "q3", "q4"];

/** Quadrant(IPC enum) → 단축 zone 키. */
export function quadrantToZone(q: Quadrant): ZoneKey {
  switch (q) {
    case "q1_do_now":
      return "q1";
    case "q2_schedule":
      return "q2";
    case "q3_quick_contain":
      return "q3";
    case "q4_drop":
      return "q4";
    case "unclassified":
      return "unclassified";
  }
}

/** 단축 zone 키 → Quadrant(IPC enum). */
export function zoneToQuadrant(z: ZoneKey): Quadrant {
  switch (z) {
    case "q1":
      return "q1_do_now";
    case "q2":
      return "q2_schedule";
    case "q3":
      return "q3_quick_contain";
    case "q4":
      return "q4_drop";
    case "unclassified":
      return "unclassified";
  }
}

// ── 태그 파서 (프로토타입 parseDump와 동일 규칙) ──
const PERSONAL = ["개인", "내", "나", "사적", "personal", "p"];
const WORK = ["업무", "일", "회사", "직장", "work", "w"];

/** 한 줄 입력을 맨앞 토큰 마커로 파싱. kind=null이면 토글 기본값을 쓰도록 호출부가 결정. */
export function parseDump(raw: string): { kind: Kind | null; text: string } {
  const m = raw.match(/^\s*([^\s,]+)\s*[,\s]\s*(.+)$/);
  if (m) {
    const h = m[1];
    const l = h.toLowerCase();
    if (PERSONAL.includes(h) || PERSONAL.includes(l))
      return { kind: "personal", text: m[2].trim() };
    if (WORK.includes(h) || WORK.includes(l))
      return { kind: "work", text: m[2].trim() };
  }
  return { kind: null, text: raw.trim() };
}

/** ISO/날짜 문자열 → "M/D" (생성일 micro 표기). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** kind 칩 라벨/클래스. */
export function kindLabel(kind: Kind): string {
  return kind === "work" ? "업무" : "개인";
}
export function kindChipClass(kind: Kind): string {
  return kind === "work" ? "chip-work" : "chip-personal";
}

/** 라이프 도메인(area) 한국어 라벨 (닫힌 taxonomy, Phase 9 enrich). */
const AREA_LABELS: Record<AreaTag, string> = {
  health: "건강",
  work: "업무",
  studies: "학습",
  environment: "환경",
  recreation: "휴식",
  romance: "연애",
  family: "가족",
  friends: "친구",
  finances: "재정",
  other: "기타",
};
export function areaLabel(area: AreaTag): string {
  return AREA_LABELS[area];
}

/** suggested_quadrant(문자열 힌트) → 짧은 배지(Q1~Q4). 미분류/미상은 빈 문자열. */
export function suggestedQuadrantBadge(q: string | null): string {
  switch (q) {
    case "q1_do_now":
      return "Q1?";
    case "q2_schedule":
      return "Q2?";
    case "q3_quick_contain":
      return "Q3?";
    case "q4_drop":
      return "Q4?";
    default:
      return "";
  }
}

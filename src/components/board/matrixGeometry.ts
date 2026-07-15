export const CARD_WIDTH = 150;
export const CARD_HEIGHT = 92;
export const CARD_GAP = 12;
export const INBOX_FOOTER_HEIGHT = 48;

export type MatrixZoneKey = "unclassified" | "q1" | "q2" | "q3" | "q4";

export type MatrixRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CardPosition = {
  x: number;
  y: number;
  rotation: number;
};

export function computeInboxHeight({
  itemCount,
  width,
  cardWidth = CARD_WIDTH,
  cardHeight = CARD_HEIGHT,
  gap = CARD_GAP,
  footerHeight = INBOX_FOOTER_HEIGHT,
}: {
  itemCount: number;
  width: number;
  cardWidth?: number;
  cardHeight?: number;
  gap?: number;
  footerHeight?: number;
}): number {
  const cols = Math.max(1, Math.floor((width - 24) / (cardWidth + gap)));
  const rows = Math.max(1, Math.ceil((itemCount || 1) / cols));
  return 40 + rows * (cardHeight + gap) + 8 + footerHeight;
}

export function computeZonePositions({
  count,
  zone,
  rect,
  cardWidth = CARD_WIDTH,
  cardHeight = CARD_HEIGHT,
  gap = CARD_GAP,
  footerHeight = INBOX_FOOTER_HEIGHT,
}: {
  count: number;
  zone: MatrixZoneKey;
  rect: MatrixRect;
  cardWidth?: number;
  cardHeight?: number;
  gap?: number;
  footerHeight?: number;
}): CardPosition[] {
  if (zone === "unclassified") {
    const cols = Math.max(1, Math.floor((rect.w - 24) / (cardWidth + gap)));
    if (cols <= 1) {
      const top = rect.y + 40;
      const bot = rect.y + rect.h - cardHeight - 8 - footerHeight;
      const step = count > 1 ? Math.min(58, (bot - top) / (count - 1)) : 0;
      return Array.from({ length: count }, (_, i) => ({
        x: rect.x + 16 + (i % 2) * 12,
        y: top + i * step,
        rotation: i % 2 ? 2 : -2,
      }));
    }

    return Array.from({ length: count }, (_, i) => {
      const col = i % cols;
      const row = (i / cols) | 0;
      return {
        x: rect.x + 14 + col * (cardWidth + gap),
        y: rect.y + 40 + row * (cardHeight + gap),
        rotation: 0,
      };
    });
  }

  const cols = Math.max(1, Math.floor((rect.w - 28) / (cardWidth + gap)));
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols;
    const row = (i / cols) | 0;
    return {
      x: rect.x + 14 + col * (cardWidth + gap),
      y: rect.y + 38 + row * (cardHeight + gap),
      rotation: 0,
    };
  });
}

export function rectContainsPoint(rect: MatrixRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

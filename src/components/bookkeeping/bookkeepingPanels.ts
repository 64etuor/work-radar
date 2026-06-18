export const BOOKKEEPING_INPUT_PANEL_ORDER = ["manual", "recurring"] as const;

export type BookkeepingInputPanel = (typeof BOOKKEEPING_INPUT_PANEL_ORDER)[number];

export const BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN = {
  manual: true,
  recurring: true,
} satisfies Record<BookkeepingInputPanel, boolean>;

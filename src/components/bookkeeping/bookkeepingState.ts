import { stepMonthValue } from "@/components/periodNavigatorUtils";

import { ALL_PROJECTS } from "./bookkeepingConstants";
import { currentMonth } from "./bookkeepingMonth";
import type { BookkeepingInputPanel } from "./bookkeepingPanels";

export type InputPanelAction = {
  panel: BookkeepingInputPanel;
  open: boolean;
};

export type BookkeepingScopeState = {
  month: string;
  projectId: string;
};

export type BookkeepingScopeAction =
  | { type: "setProject"; projectId: string }
  | { type: "stepMonth"; months: -1 | 1 }
  | { type: "resetMonth" };

export function initialBookkeepingScope(): BookkeepingScopeState {
  return {
    month: currentMonth(),
    projectId: ALL_PROJECTS,
  };
}

export function bookkeepingScopeReducer(
  current: BookkeepingScopeState,
  action: BookkeepingScopeAction,
): BookkeepingScopeState {
  if (action.type === "setProject") {
    if (current.projectId === action.projectId) {
      return current;
    }
    return { ...current, projectId: action.projectId };
  }
  if (action.type === "stepMonth") {
    return { ...current, month: stepMonthValue(current.month, action.months) };
  }
  return { ...current, month: currentMonth() };
}

export function inputPanelsReducer(
  current: Record<BookkeepingInputPanel, boolean>,
  action: InputPanelAction,
): Record<BookkeepingInputPanel, boolean> {
  if (current[action.panel] === action.open) {
    return current;
  }
  return { ...current, [action.panel]: action.open };
}

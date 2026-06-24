export type BookkeepingTriageCommand =
  | "move_next"
  | "move_previous"
  | "approve"
  | "delete"
  | "focus_search"
  | "focus_category"
  | "toggle_help";

export type BookkeepingTriageState = {
  activeIndex: number;
  helpOpen: boolean;
};

export function triageCommandForKey(key: string): BookkeepingTriageCommand | null {
  switch (key) {
    case "j":
    case "ArrowDown":
      return "move_next";
    case "k":
    case "ArrowUp":
      return "move_previous";
    case "e":
      return "approve";
    case "x":
      return "delete";
    case "/":
      return "focus_search";
    case "c":
      return "focus_category";
    case "?":
      return "toggle_help";
    default:
      return null;
  }
}

export function reduceBookkeepingTriageState(
  state: BookkeepingTriageState,
  command: BookkeepingTriageCommand,
  rowCount: number,
): BookkeepingTriageState {
  if (rowCount <= 0) {
    return {
      activeIndex: -1,
      helpOpen: command === "toggle_help" ? !state.helpOpen : state.helpOpen,
    };
  }
  switch (command) {
    case "move_next":
      return {
        ...state,
        activeIndex: state.activeIndex < 0 ? 0 : Math.min(rowCount - 1, state.activeIndex + 1),
      };
    case "move_previous":
      return {
        ...state,
        activeIndex: state.activeIndex < 0 ? 0 : Math.max(0, state.activeIndex - 1),
      };
    case "toggle_help":
      return { ...state, helpOpen: !state.helpOpen };
    default:
      return { ...state, activeIndex: Math.max(0, Math.min(state.activeIndex, rowCount - 1)) };
  }
}

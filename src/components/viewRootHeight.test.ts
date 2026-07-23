import { describe, expect, it } from "vitest";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");

/**
 * 뷰 루트 높이 회귀 가드.
 *
 * 모든 최상위 뷰는 App 셸의 `.view-shell` 안에 마운트된다. `.view-shell`은 이미
 * `flex:1`로 AgentStatusBar와 하단 뉴스 티커 슬롯을 제외한 실제 가용 높이를 갖는다.
 * 따라서 뷰 루트는 `height: 100%`로 그 컨테이너를 채워야 한다. `100vh`/`100dvh`를 쓰면
 * 뷰가 뷰포트 전체 높이가 되어 (에이전트 바 + 티커)만큼 아래로 넘치고, `.view-shell`의
 * `overflow: clip`에 의해 하단이 **잘린다**(스크롤 불가). — CaptureBoard(.cb)가 정본 패턴.
 */
const VIEW_ROOTS: Array<{ file: string; selector: string }> = [
  { file: "MissionView.css", selector: ".mission" },
  { file: "WeeklyView.css", selector: ".wk" },
  { file: "PrRadarView.css", selector: ".pr" },
  { file: "jobs/JobsView.css", selector: ".jobs" },
  { file: "worktree/WorktreeView.css", selector: ".wt" },
  { file: "CaptureBoard.css", selector: ".cb" },
  { file: "TodayView.css", selector: ".today" },
  { file: "SettingsView.css", selector: ".settings" },
  { file: "RoutineTrackingView.css", selector: ".rt" },
  { file: "SkillsView.css", selector: ".skl" },
  { file: "bookkeeping/BookkeepingView.css", selector: ".bk-view" },
  { file: "reading/ReadingView.css", selector: ".rd" },
  { file: "control-room/ControlRoomView.css", selector: ".cr-view" },
];

/** `selector { ... }` 첫 블록 본문을 반환(정확히 그 셀렉터, 컴파운드 제외).
 *  주석 안의 중괄호(예: CaptureBoard의 `--cb-r-{sm,md,lg}`)가 블록 끝을 오탐하지 않도록
 *  먼저 `/* *\/` 주석을 제거한다. 플랫 룰이라 주석 제거 후 첫 `}`가 블록 끝. */
function rootBlock(cssRaw: string, selector: string): string {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
  if (!match) throw new Error(`root selector ${selector} not found`);
  const start = match.index + match[0].length;
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`unterminated block for ${selector}`);
  return css.slice(start, end);
}

describe("view root height", () => {
  it.each(VIEW_ROOTS)(
    "$selector fills its shell container with height:100% (never a viewport unit)",
    ({ file, selector }) => {
      const path = resolve?.(__dirname, file) ?? "";
      const block = rootBlock(readFileSync?.(path, "utf8") ?? "", selector);
      expect(block, `${selector} must use height: 100%`).toMatch(/height:\s*100%/);
      expect(
        block,
        `${selector} must not use a viewport height (clips under the ticker)`,
      ).not.toMatch(/height:\s*100d?vh/);
    },
  );
});

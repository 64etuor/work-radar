// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineToday } from "@/bindings";

import { type RoutineDraft, RoutinesPanel } from "./RoutinesPanel";

// 분해 회귀 잠금 baseline(frontend-shell.md §분해 회귀 잠금). RoutinesPanel은 폼/리스트 분해 전후로
// 동일 동작을 유지해야 한다: 리스트 렌더·생성 플로우·수정 populate·체크 토글·재오픈 리셋.

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function routine(over: Partial<RoutineToday> = {}): RoutineToday {
  return {
    id: "r1",
    title: "아침 운동",
    freq: "daily",
    weekdays: [],
    anchorDate: null,
    timeOfDay: null,
    reminderOffsetMin: null,
    area: null,
    areaTags: null,
    kind: null,
    done: false,
    timeOverride: null,
    linkedEventId: null,
    linkedCalendarId: null,
    monthlyPattern: null,
    monthlyNthWeek: null,
    durationMin: null,
    googleEventId: null,
    googleCalendarId: null,
    ...over,
  };
}

type Handlers = {
  onCreate: ReturnType<typeof vi.fn<(draft: RoutineDraft) => void>>;
  onUpdate: ReturnType<typeof vi.fn<(id: string, draft: RoutineDraft) => void>>;
  onToggle: ReturnType<typeof vi.fn<(routineId: string, done: boolean) => void>>;
};

function render(routines: RoutineToday[]): Handlers {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const h: Handlers = {
    onCreate: vi.fn<(draft: RoutineDraft) => void>(),
    onUpdate: vi.fn<(id: string, draft: RoutineDraft) => void>(),
    onToggle: vi.fn<(routineId: string, done: boolean) => void>(),
  };
  act(() => {
    root?.render(
      <RoutinesPanel
        routines={routines}
        lifeWheelTags={[]}
        projects={[]}
        onToggle={h.onToggle}
        onCreate={h.onCreate}
        onUpdate={h.onUpdate}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        onOpenTracking={vi.fn()}
        onSetKind={vi.fn()}
        onSetAreaTagKey={vi.fn()}
        onEnableSync={vi.fn()}
        onDisableSync={vi.fn()}
        onMoveSync={vi.fn()}
      />,
    );
  });
  return h;
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container?.querySelectorAll("button") ?? []).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function setInputValue(el: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function titleInput(): HTMLInputElement {
  const el = container?.querySelector<HTMLInputElement>("[data-cb-routine-title]");
  if (!el) throw new Error("title input not found");
  return el;
}

function submitForm() {
  const form = container?.querySelector("form");
  if (!form) throw new Error("form not found");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("RoutinesPanel behavior baseline", () => {
  it("renders routine titles and schedule labels", () => {
    render([
      routine({ id: "r1", title: "아침 운동", freq: "daily" }),
      routine({ id: "r2", title: "독서", freq: "weekly", weekdays: ["mon", "wed"] }),
    ]);
    const text = container?.textContent ?? "";
    expect(text).toContain("아침 운동");
    expect(text).toContain("독서");
    expect(text).toContain("매일");
    expect(text).toContain("월·수");
  });

  it("shows empty hint when no routines", () => {
    render([]);
    expect(container?.textContent ?? "").toContain("오늘 해당하는 루틴이 없습니다");
  });

  it("create flow: opens form, submits draft via onCreate", () => {
    const h = render([]);
    click(buttonByText("+ 루틴"));
    setInputValue(titleInput(), "명상");
    submitForm();
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    const draft = h.onCreate.mock.calls[0][0];
    expect(draft.title).toBe("명상");
    expect(draft.freq).toBe("daily");
    expect(draft.weekdays).toEqual([]);
    expect(h.onUpdate).not.toHaveBeenCalled();
  });

  it("create flow: blank title does not submit", () => {
    const h = render([]);
    click(buttonByText("+ 루틴"));
    setInputValue(titleInput(), "   ");
    submitForm();
    expect(h.onCreate).not.toHaveBeenCalled();
  });

  it("edit flow: pencil populates form, submits via onUpdate", () => {
    const h = render([routine({ id: "r1", title: "아침 운동", freq: "daily" })]);
    click(container!.querySelector('[aria-label="루틴 수정"]')!);
    expect(titleInput().value).toBe("아침 운동");
    setInputValue(titleInput(), "아침 운동2");
    submitForm();
    expect(h.onUpdate).toHaveBeenCalledTimes(1);
    expect(h.onUpdate.mock.calls[0][0]).toBe("r1");
    expect(h.onUpdate.mock.calls[0][1].title).toBe("아침 운동2");
    expect(h.onCreate).not.toHaveBeenCalled();
  });

  it("toggle: clicking the checkbox calls onToggle", () => {
    const h = render([routine({ id: "r1", title: "아침 운동", done: false })]);
    const checkbox = container?.querySelector('[role="checkbox"]');
    expect(checkbox).toBeTruthy();
    click(checkbox!);
    expect(h.onToggle).toHaveBeenCalledWith("r1", true);
  });

  it("reopening create form resets the title field", () => {
    render([]);
    click(buttonByText("+ 루틴"));
    setInputValue(titleInput(), "임시");
    expect(titleInput().value).toBe("임시");
    click(buttonByText("+ 루틴"));
    expect(titleInput().value).toBe("");
  });

  // seam 잠금: A 수정 중 B 연필 클릭 → openSeq 증가 + key remount로 B 값 재시드(A 값 잔존 금지).
  it("switching edit target A→B re-populates the form with B", () => {
    render([routine({ id: "r1", title: "운동" }), routine({ id: "r2", title: "독서" })]);
    const pencils = container?.querySelectorAll('[aria-label="루틴 수정"]');
    click(pencils![0]); // A
    expect(titleInput().value).toBe("운동");
    click(pencils![1]); // B
    expect(titleInput().value).toBe("독서");
  });

  // seam 잠금: 비자명 필드(시간 + weekly 요일)도 initial에서 재시드되는지.
  it("edit populates non-trivial fields (time + weekly weekdays)", () => {
    render([
      routine({
        id: "r1",
        title: "독서",
        freq: "weekly",
        weekdays: ["mon", "wed"],
        timeOfDay: "07:00",
      }),
    ]);
    click(container!.querySelector('[aria-label="루틴 수정"]')!);
    expect(titleInput().value).toBe("독서");
    const timeInput = container?.querySelector<HTMLInputElement>('input[type="time"]');
    expect(timeInput?.value).toBe("07:00");
    // 월·수 요일 버튼이 선택(aria-pressed) 상태로 시드됐는지.
    const dayBtns = Array.from(container?.querySelectorAll("button") ?? []).filter((b) =>
      ["월", "수"].includes(b.textContent?.trim() ?? ""),
    );
    expect(dayBtns.length).toBe(2);
    expect(dayBtns.every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
  });
});

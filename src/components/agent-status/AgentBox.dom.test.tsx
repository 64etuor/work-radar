// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBox } from "./AgentBox";
import type { SessionBox } from "./shared";

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

const box: SessionBox = {
  key: "cmux:demo",
  engine: "claude",
  name: "demo",
  state: "idle",
  stateLabel: "대기",
  startedMs: null,
  timeoutSec: null,
  title: "demo box",
};

function renderBox(editing = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentBox
        box={box}
        displayName="demo"
        nowMs={0}
        editing={editing}
        onOpen={vi.fn()}
        onEditStart={vi.fn()}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  });
}

describe("AgentBox focus retention guard", () => {
  it("마우스 pointerdown의 기본 동작(포커스 이동)을 막는다 — 잔류 포커스가 이후 Enter를 하이재킹하지 않도록", () => {
    renderBox();
    const btn = container?.querySelector(".asb-box");
    expect(btn).not.toBeNull();
    const e = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      btn?.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it("이름 편집 중에는 pointerdown을 막지 않는다(입력 포커스 보존)", () => {
    renderBox(true);
    const boxEl = container?.querySelector(".asb-box");
    expect(boxEl).not.toBeNull();
    const e = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      boxEl?.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
  });
});

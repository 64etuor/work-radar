// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePresence } from "./usePresence";

const EXIT_MS = 120;

/**
 * 마운트 시 1회만 발화하는 효과를 가진 자식 — CommandPalette의 `autoFocus`(마운트 전용)
 * 대역이다. openKey가 진짜 재마운트를 일으키는지 이 카운트로 관찰한다.
 */
function Child({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return null;
}

function Probe({
  open,
  exitMs = EXIT_MS,
  onChildMount = () => {},
}: {
  open: boolean;
  exitMs?: number;
  onChildMount?: () => void;
}) {
  const presence = usePresence(open, exitMs);
  if (!presence.mounted) return null;
  return (
    <div data-testid="node" data-state={presence.state} data-open-key={presence.openKey}>
      <Child key={presence.openKey} onMount={onChildMount} />
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(open: boolean, opts: { exitMs?: number; onChildMount?: () => void } = {}) {
  act(() => {
    root?.render(<Probe open={open} {...opts} />);
  });
}

function node() {
  return document.querySelector('[data-testid="node"]');
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("usePresence", () => {
  it("mounts immediately when open and reports state=open", () => {
    render(true);
    expect(node()?.getAttribute("data-state")).toBe("open");
  });

  it("does not mount, nor schedule an exit, when it starts closed", () => {
    render(false);
    expect(node()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the node mounted as state=closed for exitMs, then unmounts", () => {
    render(true);
    render(false);

    // exit 애니메이션이 재생될 시간 — 여기서 언마운트되면 닫힘이 하드 컷이 된다.
    expect(node()?.getAttribute("data-state")).toBe("closed");

    advance(EXIT_MS - 1);
    expect(node()).not.toBeNull();

    advance(1);
    expect(node()).toBeNull();
  });

  it("cancels the pending exit when reopened mid-exit", () => {
    render(true);
    render(false);
    advance(EXIT_MS - 20);
    render(true);

    expect(node()?.getAttribute("data-state")).toBe("open");

    // 취소된 타이머가 뒤늦게 발화해 열려 있는 노드를 언마운트하면 안 된다.
    advance(EXIT_MS * 2);
    expect(node()?.getAttribute("data-state")).toBe("open");
  });

  it("still unmounts on the exit that follows a reopen", () => {
    render(true);
    render(false);
    advance(EXIT_MS - 20);
    render(true);
    render(false);

    expect(node()?.getAttribute("data-state")).toBe("closed");
    advance(EXIT_MS);
    expect(node()).toBeNull();
  });

  it("clears the exit timer on unmount", () => {
    render(true);
    render(false);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  // exitMs를 effect deps에 넣으면 여기서 걸린다: cleanup이 타이머만 지우고 재실행이
  // `!prevOpen` early-return에 막혀 재예약을 못 해 isClosing이 영구히 true로 남는다.
  it("does not strand the exit when exitMs changes while closed", () => {
    render(true);
    render(false);
    advance(EXIT_MS / 2);

    render(false, { exitMs: 500 });

    advance(EXIT_MS);
    expect(node()).toBeNull();
  });

  it("survives StrictMode double-invoked effects", () => {
    act(() => {
      root?.render(
        <StrictMode>
          <Probe open />
        </StrictMode>,
      );
    });
    expect(node()?.getAttribute("data-state")).toBe("open");

    act(() => {
      root?.render(
        <StrictMode>
          <Probe open={false} />
        </StrictMode>,
      );
    });
    expect(node()?.getAttribute("data-state")).toBe("closed");

    advance(EXIT_MS);
    expect(node()).toBeNull();
  });
});

describe("usePresence openKey", () => {
  it("닫힐 때 자식을 언마운트했다 되살리지 않는다(exit 재시작·1프레임 깜빡임)", () => {
    const onChildMount = vi.fn();

    render(true, { onChildMount });
    expect(onChildMount).toHaveBeenCalledTimes(1);

    // closing을 effect에서 켜면 open=false인 첫 커밋에 mounted가 잠깐 false가 되어
    // 서브트리가 통째로 갈린다. 그러면 여기서 마운트가 한 번 더 잡힌다.
    render(false, { onChildMount });
    expect(node()?.getAttribute("data-state")).toBe("closed");
    expect(onChildMount).toHaveBeenCalledTimes(1);
  });

  it("bumps only on closed→open, so the exit animation is not interrupted", () => {
    render(false);
    render(true);
    const first = node()?.getAttribute("data-open-key");

    render(false);
    // exit 중에는 키가 그대로여야 한다 — 바뀌면 노드가 갈려 애니메이션이 끊긴다.
    expect(node()?.getAttribute("data-open-key")).toBe(first);
  });

  it("remounts the child on reopen, even when the exit never completed", () => {
    const onChildMount = vi.fn();

    render(true, { onChildMount });
    expect(onChildMount).toHaveBeenCalledTimes(1);

    render(false, { onChildMount });
    advance(EXIT_MS / 2); // 아직 언마운트 전 — 여기서 다시 연다

    render(true, { onChildMount });

    // 키가 없으면 자식이 살아 있어 autoFocus(마운트 전용)가 다시 돌지 않는다.
    expect(onChildMount).toHaveBeenCalledTimes(2);
  });
});

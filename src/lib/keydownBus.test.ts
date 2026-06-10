import { describe, expect, it } from "vitest";

import { dispatchKeydown, KEYDOWN_PRIORITY, registerKeydown } from "./keydownBus";

/** node 환경 — window 없음. dispatchKeydown을 직접 호출(버스 자체가 wiring과 분리돼 있음). */
const EVENT = { key: "1", metaKey: true } as KeyboardEvent;

describe("keydownBus", () => {
  it("우선순위 내림차순으로 호출, true 반환 시 이후 핸들러 미호출(소비)", () => {
    const calls: string[] = [];
    const un1 = registerKeydown(KEYDOWN_PRIORITY.hermes, () => {
      calls.push("hermes");
      return true; // 소비
    });
    const un2 = registerKeydown(KEYDOWN_PRIORITY.keymap, () => {
      calls.push("keymap");
    });
    dispatchKeydown(EVENT);
    expect(calls).toEqual(["hermes"]);
    un1();
    un2();
  });

  it("관찰 전용 knobWatch는 소비자(hermes)보다 먼저 — 소비될 키도 관찰", () => {
    const calls: string[] = [];
    const un1 = registerKeydown(KEYDOWN_PRIORITY.hermes, () => {
      calls.push("hermes");
      return true;
    });
    const un2 = registerKeydown(KEYDOWN_PRIORITY.knobWatch, () => {
      calls.push("knobWatch");
    });
    dispatchKeydown(EVENT);
    expect(calls).toEqual(["knobWatch", "hermes"]);
    un1();
    un2();
  });

  it("void 반환은 통과 — 같은 우선순위는 등록 순(FIFO)", () => {
    const calls: string[] = [];
    const un1 = registerKeydown(KEYDOWN_PRIORITY.keymap, () => {
      calls.push("a");
    });
    const un2 = registerKeydown(KEYDOWN_PRIORITY.keymap, () => {
      calls.push("b");
    });
    dispatchKeydown(EVENT);
    expect(calls).toEqual(["a", "b"]);
    un1();
    un2();
  });

  it("해제된 핸들러는 호출되지 않음 + 재등록해도 우선순위가 순서를 결정(마운트 순서 무관)", () => {
    const calls: string[] = [];
    const unHermes = registerKeydown(KEYDOWN_PRIORITY.hermes, () => {
      calls.push("hermes");
    });
    unHermes();
    // keymap을 먼저, hermes를 나중에 등록해도(재등록 시나리오) hermes가 먼저 실행.
    const un1 = registerKeydown(KEYDOWN_PRIORITY.keymap, () => {
      calls.push("keymap");
    });
    const un2 = registerKeydown(KEYDOWN_PRIORITY.hermes, () => {
      calls.push("hermes2");
    });
    dispatchKeydown(EVENT);
    expect(calls).toEqual(["hermes2", "keymap"]);
    un1();
    un2();
  });

  it("핸들러가 틱 도중 해제돼도 안전(스냅샷 순회)", () => {
    const calls: string[] = [];
    let unB: () => void = () => {};
    const unA = registerKeydown(KEYDOWN_PRIORITY.hermes, () => {
      calls.push("a");
      unB(); // 다음 핸들러를 틱 도중 해제 — 이번 틱은 스냅샷이라 그대로 호출됨
    });
    unB = registerKeydown(KEYDOWN_PRIORITY.keymap, () => {
      calls.push("b");
    });
    dispatchKeydown(EVENT);
    expect(calls).toEqual(["a", "b"]);
    dispatchKeydown(EVENT); // 다음 틱부터는 미호출
    expect(calls).toEqual(["a", "b", "a"]);
    unA();
  });
});

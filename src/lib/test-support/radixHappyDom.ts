// happy-dom엔 없는 브라우저 API(ResizeObserver / pointer capture / scrollIntoView)를 채우는 테스트
// shim. Radix Popover/Dialog 등을 dom 테스트(`// @vitest-environment happy-dom`)에서 띄울 때
// `beforeAll(installRadixHappyDomShim)`로 호출한다. 멱등(이미 있으면 덮어쓰지 않음).
export function installRadixHappyDomShim(): void {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, () => unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
}

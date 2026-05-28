# Hermes Floating Panel + ACP Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `HermesView` (currently Telegram bridge UI) with a draggable/resizable in-renderer floating panel, wire it to a local `hermes acp` subprocess for streaming chat, and add slash-command autocomplete, image input (paste/drop/picker), Hermes detection in Settings, and a configurable OS-global toggle hotkey.

**Architecture:** A new Rust module `src-tauri/src/hermes_agent/` owns the `hermes acp` child via LSP-framed JSON-RPC over stdio, exposing typed Tauri commands + Specta events. The frontend uses an in-renderer `<div>` with pointer-event drag/resize (not a Tauri window), persists position/size/open in `app_config`, and registers an OS-global toggle hotkey via the existing `tauri-plugin-global-shortcut` infrastructure. ACP `available_commands` drives `/` autocomplete; clipboard/drop/picker images go to a temp file and become ACP `image` content (file path default, base64 session-sticky fallback).

**Tech Stack:** Rust (tokio process, sqlx, tauri-specta, tauri-plugin-global-shortcut), TypeScript/React 19, shadcn/ui (Textarea, Button), TanStack Query, Tailwind v4, vitest.

**Source-of-truth references:**
- Spec: `docs/superpowers/specs/2026-05-28-hermes-floating-panel-design.md`
- Existing hotkey infra: `src-tauri/src/shortcut.rs`, `src-tauri/src/commands/nav.rs`
- Existing settings storage: `app_config` table (migration 0014, `src-tauri/src/db.rs:386–448`)
- Existing settings UI pattern: `src/components/settings/NavigationSettings.tsx` (`GlobalHotkeyCapture` widget 208–261)
- IPC bindings emit: `pnpm bindings:generate` (specta) — see `docs/areas/ipc-conventions.md`

**Phase ordering (single branch `feat/hermes-floating`, no PR splits):**
- **Phase A** Panel shell + persistent state + toggle hotkey (no chat)
- **Phase B** Hermes detect + Settings connection block
- **Phase C** Rust ACP client + IPC commands + events (backend only, mock stdio tests)
- **Phase D** Wire panel to ACP (real streaming chat)
- **Phase E** Slash commands + image input

---

## Phase A — Panel Shell + Persistent State + Toggle Hotkey

Outcome: Existing `HermesView` becomes a draggable/resizable floating panel; position/size/open persists; global hotkey `Cmd+Shift+Space` toggles open/close; Settings has a "Hermes Panel" block with hotkey capture + reset button. Chat content is a placeholder.

### Task A1: Add `hermes_panel_state` commands (Rust)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (export new module)
- Create: `src-tauri/src/commands/hermes_panel.rs`
- Modify: `src-tauri/src/lib.rs` (register commands in builder)
- Modify: `src-tauri/src/error.rs` (no new variant — uses existing `AppError::Db`)

- [ ] **Step 1: Write failing test for state roundtrip**

Create `src-tauri/src/commands/hermes_panel.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn mem_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            .execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn roundtrip_panel_state() {
        let pool = mem_pool().await;
        let state = HermesPanelState { x: 100.0, y: 200.0, w: 460.0, h: 600.0, open: true };
        set_state(&pool, &state).await.unwrap();
        let got = get_state(&pool).await.unwrap();
        assert_eq!(got, state);
    }

    #[tokio::test]
    async fn default_when_missing() {
        let pool = mem_pool().await;
        let got = get_state(&pool).await.unwrap();
        assert_eq!(got.open, false);
        assert!(got.w >= 360.0 && got.h >= 320.0);
    }
}
```

- [ ] **Step 2: Implement minimal types + helpers**

Add to `src-tauri/src/commands/hermes_panel.rs`:

```rust
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use specta::Type;

const KEY: &str = "hermes.panel";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct HermesPanelState {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub open: bool,
}

impl Default for HermesPanelState {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, w: 460.0, h: 600.0, open: false }
    }
}

async fn get_state(pool: &SqlitePool) -> Result<HermesPanelState, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_config WHERE key = ?1")
        .bind(KEY)
        .fetch_optional(pool)
        .await?;
    match row {
        Some((s,)) => Ok(serde_json::from_str(&s).map_err(|e| AppError::Db(e.to_string()))?),
        None => Ok(HermesPanelState::default()),
    }
}

async fn set_state(pool: &SqlitePool, state: &HermesPanelState) -> Result<(), AppError> {
    let s = serde_json::to_string(state).map_err(|e| AppError::Db(e.to_string()))?;
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
    )
    .bind(KEY)
    .bind(&s)
    .execute(pool)
    .await?;
    Ok(())
}
```

(If `AppError::Db` doesn't take `String`, match the existing variant in `src-tauri/src/error.rs` — check that file for the right constructor.)

- [ ] **Step 3: Run unit test**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml hermes_panel
```

Expected: 2 passed.

- [ ] **Step 4: Add Tauri commands**

Append to `src-tauri/src/commands/hermes_panel.rs`:

```rust
use tauri::State;
use crate::app_state::AppHandleState;  // adjust to actual state holder name

#[tauri::command]
#[specta::specta]
pub async fn hermes_panel_state_get(state: State<'_, AppHandleState>) -> Result<HermesPanelState, AppError> {
    get_state(state.pool()).await
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_panel_state_set(state: State<'_, AppHandleState>, value: HermesPanelState) -> Result<(), AppError> {
    set_state(state.pool(), &value).await
}
```

Find the actual app state holder by `rg "tauri::command" src-tauri/src/commands/nav.rs` and follow the same `State<'_, ...>` shape used there.

- [ ] **Step 5: Register in builder**

In `src-tauri/src/lib.rs` (find `invoke_handler!` / specta collect_commands! list — usually wrapped via tauri-specta `Builder::new().commands(...)`):

```rust
// in the commands list
hermes_panel::hermes_panel_state_get,
hermes_panel::hermes_panel_state_set,
```

In `src-tauri/src/commands/mod.rs`:

```rust
pub mod hermes_panel;
```

- [ ] **Step 6: Regenerate specta bindings**

```bash
cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test export_bindings 2>&1 | tail -3
```

Or whatever the project command is — check `docs/reference/commands.md`. Then:

```bash
git diff src/bindings.ts | head -40
```

Expected: new `hermes_panel_state_get`, `hermes_panel_state_set`, `HermesPanelState` exports.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/hermes_panel.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/bindings.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(hermes): add panel state persist commands"
```

---

### Task A2: Add `hermes_toggle_hotkey` commands + handler

**Files:**
- Modify: `src-tauri/src/shortcut.rs` (add `register_hermes_toggle`)
- Modify: `src-tauri/src/commands/hermes_panel.rs` (add hotkey get/set)
- Modify: `src-tauri/src/lib.rs` (call register at startup)

- [ ] **Step 1: Read existing shortcut patterns**

```bash
sed -n '1,200p' src-tauri/src/shortcut.rs
```

Note: `register_spec`, `reregister`, and the `app_config` key `nav.global_hotkey`. Replicate this pattern.

- [ ] **Step 2: Add hermes hotkey storage helpers**

In `src-tauri/src/commands/hermes_panel.rs`:

```rust
const HOTKEY_KEY: &str = "hermes.toggle_hotkey";
const HOTKEY_DEFAULT: &str = "Cmd+Shift+Space";

pub async fn get_hotkey(pool: &SqlitePool) -> Result<String, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_config WHERE key = ?1")
        .bind(HOTKEY_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v).unwrap_or_else(|| HOTKEY_DEFAULT.to_string()))
}

pub async fn set_hotkey(pool: &SqlitePool, spec: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
    )
    .bind(HOTKEY_KEY)
    .bind(spec)
    .execute(pool)
    .await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_get_toggle_hotkey(state: State<'_, AppHandleState>) -> Result<String, AppError> {
    get_hotkey(state.pool()).await
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_set_toggle_hotkey(
    app: tauri::AppHandle,
    state: State<'_, AppHandleState>,
    spec: String,
) -> Result<(), AppError> {
    // 1. parse + try to register first; if it fails, do not persist
    crate::shortcut::reregister_hermes_toggle(&app, &spec)?;
    set_hotkey(state.pool(), &spec).await
}
```

- [ ] **Step 3: Add `register_hermes_toggle` in shortcut.rs**

Append to `src-tauri/src/shortcut.rs` (mirror `register_spec` shape):

```rust
pub fn register_hermes_toggle(app: &tauri::AppHandle, spec: &str) -> Result<(), AppError> {
    let shortcut = parse_shortcut(spec)?;
    app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, _event| {
        let _ = app.emit("hermes:toggle", ());
    }).map_err(|e| AppError::Internal(format!("hermes hotkey register: {e}")))?;
    Ok(())
}

pub fn reregister_hermes_toggle(app: &tauri::AppHandle, spec: &str) -> Result<(), AppError> {
    // Best-effort unregister of previous hermes shortcut. The plugin doesn't
    // expose "unregister by handler" — track the active spec in a static or
    // unregister-all + reregister both nav + hermes. Simplest: track last spec.
    if let Some(prev) = LAST_HERMES_SPEC.lock().take() {
        if let Ok(prev_sc) = parse_shortcut(&prev) {
            let _ = app.global_shortcut().unregister(prev_sc);
        }
    }
    register_hermes_toggle(app, spec)?;
    *LAST_HERMES_SPEC.lock() = Some(spec.to_string());
    Ok(())
}

static LAST_HERMES_SPEC: parking_lot::Mutex<Option<String>> =
    parking_lot::const_mutex(None);
```

If the project doesn't have `parking_lot`, use `std::sync::Mutex` with `lazy_static`/`OnceLock`. Check `src-tauri/Cargo.toml`.

- [ ] **Step 4: Register at startup**

In `src-tauri/src/lib.rs` `setup` callback (find where `register_spec` is called for `nav.global_hotkey`):

```rust
let pool = app.state::<AppHandleState>().pool().clone();
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if let Ok(spec) = crate::commands::hermes_panel::get_hotkey(&pool).await {
        let _ = crate::shortcut::register_hermes_toggle(&app_handle, &spec);
    }
});
```

- [ ] **Step 5: Add the new commands to specta + invoke handler list**

Same place as Task A1 Step 5:

```rust
hermes_panel::hermes_get_toggle_hotkey,
hermes_panel::hermes_set_toggle_hotkey,
```

- [ ] **Step 6: Verify build + bindings**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
# regenerate bindings (same command as A1 Step 6)
```

- [ ] **Step 7: Commit**

```bash
git add -p src-tauri/ src/bindings.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(hermes): global toggle hotkey commands + handler"
```

---

### Task A3: `useHermesPanelState` React hook (TS + vitest)

**Files:**
- Create: `src/components/hermes/useHermesPanelState.ts`
- Create: `src/components/hermes/useHermesPanelState.test.ts`

- [ ] **Step 1: Write failing vitest**

```ts
// src/components/hermes/useHermesPanelState.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHermesPanelState } from "./useHermesPanelState";

vi.mock("@/bindings", () => ({
    commands: {
        hermesPanelStateGet: vi.fn().mockResolvedValue({ status: "ok", data: { x: 10, y: 20, w: 460, h: 600, open: false } }),
        hermesPanelStateSet: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }}});
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useHermesPanelState", () => {
    beforeEach(() => vi.clearAllMocks());

    it("loads state from backend", async () => {
        const { result } = renderHook(() => useHermesPanelState(), { wrapper });
        await waitFor(() => expect(result.current.state.x).toBe(10));
        expect(result.current.state.open).toBe(false);
    });

    it("setOpen calls backend with toggled value", async () => {
        const { commands } = await import("@/bindings");
        const { result } = renderHook(() => useHermesPanelState(), { wrapper });
        await waitFor(() => expect(result.current.state.x).toBe(10));
        act(() => result.current.setOpen(true));
        await waitFor(() => expect(commands.hermesPanelStateSet).toHaveBeenCalledWith(
            expect.objectContaining({ open: true })
        ));
    });
});
```

- [ ] **Step 2: Run — expect fail (module not found)**

```bash
pnpm vitest run src/components/hermes/useHermesPanelState.test.ts
```

- [ ] **Step 3: Implement hook**

```ts
// src/components/hermes/useHermesPanelState.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { commands, type HermesPanelState } from "@/bindings";

const DEFAULT: HermesPanelState = { x: 0, y: 0, w: 460, h: 600, open: false };

function unwrap<T>(r: { status: "ok"; data: T } | { status: "error"; error: unknown }): T {
    if (r.status === "ok") return r.data;
    throw new Error(String((r as any).error));
}

export function useHermesPanelState() {
    const qc = useQueryClient();
    const query = useQuery({
        queryKey: ["hermes-panel-state"],
        queryFn: async () => unwrap(await commands.hermesPanelStateGet()),
        staleTime: Infinity,
    });
    const state = query.data ?? DEFAULT;

    const mutation = useMutation({
        mutationFn: async (next: HermesPanelState) => unwrap(await commands.hermesPanelStateSet(next)),
        onMutate: (next) => {
            qc.setQueryData(["hermes-panel-state"], next);
        },
    });

    // debounce writes to 300ms
    const timerRef = useRef<number | null>(null);
    const pendingRef = useRef<HermesPanelState | null>(null);
    const writeDebounced = useCallback((next: HermesPanelState) => {
        pendingRef.current = next;
        qc.setQueryData(["hermes-panel-state"], next);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            if (pendingRef.current) mutation.mutate(pendingRef.current);
        }, 300);
    }, [mutation, qc]);

    const setOpen = useCallback((open: boolean) => {
        mutation.mutate({ ...state, open });
    }, [state, mutation]);

    const setBounds = useCallback((bounds: Partial<Pick<HermesPanelState, "x"|"y"|"w"|"h">>) => {
        writeDebounced({ ...state, ...bounds });
    }, [state, writeDebounced]);

    return { state, setOpen, setBounds, isLoading: query.isLoading };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm vitest run src/components/hermes/useHermesPanelState.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/hermes/useHermesPanelState.ts src/components/hermes/useHermesPanelState.test.ts
git commit -m "feat(hermes): panel state hook with debounced persistence"
```

---

### Task A4: `HermesPanel` shell — drag + resize + viewport clamp

**Files:**
- Create: `src/components/hermes/HermesPanel.tsx`
- Create: `src/components/hermes/clampToViewport.ts`
- Create: `src/components/hermes/clampToViewport.test.ts`

- [ ] **Step 1: Write failing test for clamp**

```ts
// clampToViewport.test.ts
import { describe, it, expect } from "vitest";
import { clampToViewport } from "./clampToViewport";

describe("clampToViewport", () => {
    it("returns input when inside viewport", () => {
        expect(clampToViewport({ x: 100, y: 100, w: 400, h: 500 }, 1920, 1080))
            .toEqual({ x: 100, y: 100, w: 400, h: 500 });
    });

    it("pulls panel back when off-screen right", () => {
        expect(clampToViewport({ x: 1800, y: 100, w: 400, h: 500 }, 1920, 1080).x)
            .toBeLessThanOrEqual(1920 - 400);
    });

    it("pulls panel back when negative x", () => {
        expect(clampToViewport({ x: -50, y: 100, w: 400, h: 500 }, 1920, 1080).x).toBe(0);
    });

    it("clamps height to viewport", () => {
        const r = clampToViewport({ x: 0, y: 100, w: 400, h: 2000 }, 1920, 1080);
        expect(r.h).toBeLessThanOrEqual(1080 - 100);
    });
});
```

- [ ] **Step 2: Implement**

```ts
// clampToViewport.ts
export interface Bounds { x: number; y: number; w: number; h: number }

const MIN_W = 360;
const MIN_H = 320;

export function clampToViewport(b: Bounds, vw: number, vh: number): Bounds {
    const w = Math.max(MIN_W, Math.min(b.w, vw));
    const h = Math.max(MIN_H, Math.min(b.h, vh));
    const x = Math.max(0, Math.min(b.x, vw - w));
    const y = Math.max(0, Math.min(b.y, vh - h));
    return { x, y, w, h };
}

export function defaultBounds(vw: number, vh: number): Bounds {
    const w = 460, h = 600;
    return { x: Math.max(0, vw - w - 24), y: Math.max(0, vh - h - 24), w, h };
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run src/components/hermes/clampToViewport.test.ts
```

Expected: 4 passed.

- [ ] **Step 4: Implement `HermesPanel.tsx` shell**

```tsx
// src/components/hermes/HermesPanel.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHermesPanelState } from "./useHermesPanelState";
import { clampToViewport, defaultBounds, type Bounds } from "./clampToViewport";

interface Props {
    children: React.ReactNode;
}

export function HermesPanel({ children }: Props) {
    const { state, setOpen, setBounds, isLoading } = useHermesPanelState();
    const ref = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

    // initial position default if zeros
    useEffect(() => {
        if (isLoading) return;
        if (state.x === 0 && state.y === 0 && state.w === 460 && state.h === 600) {
            const d = defaultBounds(window.innerWidth, window.innerHeight);
            setBounds(d);
        }
    }, [isLoading]);

    // global hotkey toggle
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen("hermes:toggle", () => setOpen(!state.open)).then((un) => (unlisten = un));
        return () => unlisten?.();
    }, [state.open, setOpen]);

    // Esc to close (only when no inner element has focus)
    useEffect(() => {
        if (!state.open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            const tag = (document.activeElement?.tagName ?? "").toLowerCase();
            if (tag === "input" || tag === "textarea") return;
            setOpen(false);
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [state.open, setOpen]);

    const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: state.x, origY: state.y };
    }, [state.x, state.y]);

    const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
        setBounds(clampToViewport({ x: d.origX + dx, y: d.origY + dy, w: state.w, h: state.h }, window.innerWidth, window.innerHeight));
    }, [state.w, state.h, setBounds]);

    const onHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        dragRef.current = null;
    }, []);

    const onGripPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: state.w, origH: state.h };
    }, [state.w, state.h]);

    const onGripPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const r = resizeRef.current;
        if (!r) return;
        const dw = e.clientX - r.startX, dh = e.clientY - r.startY;
        setBounds(clampToViewport({ x: state.x, y: state.y, w: r.origW + dw, h: r.origH + dh }, window.innerWidth, window.innerHeight));
    }, [state.x, state.y, setBounds]);

    const onGripPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        resizeRef.current = null;
    }, []);

    if (!state.open) return null;

    return (
        <div
            ref={ref}
            className={cn(
                "fixed z-50 rounded-lg border bg-background shadow-xl flex flex-col overflow-hidden",
            )}
            style={{
                transform: `translate3d(${state.x}px, ${state.y}px, 0)`,
                width: state.w,
                height: state.h,
            }}
            role="dialog"
            aria-label="Hermes"
        >
            <div
                className="flex items-center justify-between border-b px-3 py-2 select-none cursor-grab active:cursor-grabbing"
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
            >
                <span className="text-sm font-medium">Hermes</span>
                <Button data-no-drag variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)} aria-label="Close">
                    <X className="h-4 w-4" />
                </Button>
            </div>
            <div className="flex-1 overflow-auto">{children}</div>
            <div
                className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize"
                onPointerDown={onGripPointerDown}
                onPointerMove={onGripPointerMove}
                onPointerUp={onGripPointerUp}
            />
        </div>
    );
}
```

- [ ] **Step 5: Replace HermesView body with the new shell + placeholder**

In `src/components/HermesView.tsx`, replace the entire file content with:

```tsx
import { HermesPanel } from "./hermes/HermesPanel";

export default function HermesView() {
    return (
        <HermesPanel>
            <div className="p-4 text-sm text-muted-foreground">
                Hermes ACP chat — coming in Phase D.
            </div>
        </HermesPanel>
    );
}
```

(Adjust default vs named export to match the project convention — check how `HermesView` is imported in `src/components/AgentStatusBar.tsx` and elsewhere via `rg "from.*HermesView"`.)

- [ ] **Step 6: Remove old `HermesModal` wrapper**

In `src/components/AgentStatusBar.tsx` (lines around 355–373 per Explore report), delete the `Dialog`-wrapping `HermesModal`. Replace the trigger with whatever ergonomic mounts `<HermesView />` once at the app shell level — but the cleanest: mount `<HermesView />` unconditionally in the root layout (e.g. `App.tsx` or wherever `<Toaster />` lives). Since `HermesPanel` self-gates on `state.open`, it renders nothing when closed.

```bash
rg "HermesModal|<HermesView" src/ --files-with-matches
```

For each call site, remove the trigger/state and rely on the global hotkey + the always-mounted panel.

- [ ] **Step 7: Verify typecheck + lint**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm lint 2>&1 | tail -5
```

- [ ] **Step 8: Manual smoke** (cannot be fully automated)

```bash
pnpm tauri dev
```

Verify: hotkey `Cmd+Shift+Space` toggles the panel. Drag the header — panel moves smoothly. Resize the bottom-right grip. Restart app — position restored. Esc closes when no input focused.

If any fails: fix and rerun.

- [ ] **Step 9: Commit**

```bash
git add src/components/hermes/ src/components/HermesView.tsx src/components/AgentStatusBar.tsx
git commit -m "feat(hermes): floating panel shell with drag/resize/hotkey toggle"
```

---

### Task A5: Settings — `HermesPanelSettings` block (hotkey capture + reset)

**Files:**
- Create: `src/components/settings/HermesPanelSettings.tsx`
- Modify: wherever Settings sections are listed (look at `SettingsView.tsx` or similar — `rg "HermesBridgeBlock" src/`)

- [ ] **Step 1: Generalize `GlobalHotkeyCapture`**

Find `src/components/settings/NavigationSettings.tsx`. The current `GlobalHotkeyCapture` is likely scoped to nav's hotkey. Extract it to `src/components/settings/HotkeyCapture.tsx` with prop signature:

```tsx
interface Props {
    value: string;
    onChange: (spec: string) => Promise<void> | void;
    label?: string;
    description?: string;
}

export function HotkeyCapture({ value, onChange, label, description }: Props) { /* … existing capture logic, parameterized */ }
```

Update `NavigationSettings.tsx` to import + use the extracted component. Keep behavior identical.

- [ ] **Step 2: Implement `HermesPanelSettings`**

```tsx
// src/components/settings/HermesPanelSettings.tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { HotkeyCapture } from "./HotkeyCapture";

function unwrap<T>(r: any): T {
    if (r.status === "ok") return r.data;
    throw new Error(String(r.error));
}

export function HermesPanelSettings() {
    const qc = useQueryClient();
    const hotkey = useQuery({
        queryKey: ["hermes-toggle-hotkey"],
        queryFn: async () => unwrap<string>(await commands.hermesGetToggleHotkey()),
    });
    const setHotkey = useMutation({
        mutationFn: async (spec: string) => unwrap(await commands.hermesSetToggleHotkey(spec)),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-toggle-hotkey"] }),
    });
    const resetPos = useMutation({
        mutationFn: async () => unwrap(await commands.hermesPanelStateSet({ x: 0, y: 0, w: 460, h: 600, open: false })),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-panel-state"] }),
    });

    return (
        <section className="space-y-4 rounded-lg border p-4">
            <h3 className="text-sm font-medium">Hermes Panel</h3>
            <HotkeyCapture
                value={hotkey.data ?? "Cmd+Shift+Space"}
                onChange={(spec) => setHotkey.mutateAsync(spec)}
                label="토글 단축키"
                description="패널을 열고 닫는 OS 글로벌 단축키"
            />
            {setHotkey.isError && <p className="text-xs text-red-500">단축키 등록 실패 — 다른 앱과 충돌일 수 있습니다.</p>}
            <Button variant="outline" size="sm" onClick={() => resetPos.mutate()}>패널 위치 리셋</Button>
        </section>
    );
}
```

- [ ] **Step 3: Mount in Settings view**

Find the existing settings render (`rg "HermesBridgeBlock" src/`), and add `<HermesPanelSettings />` adjacent. Keep `HermesBridgeBlock` (Telegram bridge) intact.

- [ ] **Step 4: Manual smoke**

```bash
pnpm tauri dev
```

Open Settings → change hotkey to `Cmd+Alt+H` → press it → panel toggles. Click "패널 위치 리셋" → drag panel off-screen → click reset → position recentered.

- [ ] **Step 5: Verify + commit**

```bash
pnpm typecheck && pnpm lint
git add src/components/settings/
git commit -m "feat(hermes): settings block for toggle hotkey + position reset"
```

---

## Phase B — Hermes Detect + Settings Connection Block

Outcome: Settings shows whether `hermes` CLI is installed, the version, the path, and whether ACP is ready. A "재감지" button refetches. No login/setup UI.

### Task B1: Rust `hermes_detect` command

**Files:**
- Create: `src-tauri/src/hermes_agent/mod.rs`
- Create: `src-tauri/src/hermes_agent/detect.rs`
- Modify: `src-tauri/src/lib.rs` (register `hermes_detect`)
- Modify: `src-tauri/src/error.rs` (add `HermesSpawnFailed`)

- [ ] **Step 1: Add AppError variant**

In `src-tauri/src/error.rs`, find the `AppError` enum and add:

```rust
#[error("hermes spawn failed: {0}")]
HermesSpawnFailed(String),
```

(If `AppError` uses `thiserror`, follow the existing variant style.)

- [ ] **Step 2: Write failing test for detect parsing**

```rust
// src-tauri/src/hermes_agent/detect.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_from_stdout() {
        assert_eq!(parse_version("hermes 0.42.1\n"), Some("0.42.1".to_string()));
        assert_eq!(parse_version("Hermes Agent 0.42.1-rc1"), Some("0.42.1-rc1".to_string()));
        assert_eq!(parse_version(""), None);
    }
}
```

- [ ] **Step 3: Implement detect**

```rust
// src-tauri/src/hermes_agent/detect.rs
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HermesDetectResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub acp_ready: bool,
    pub error: Option<String>,
}

pub fn parse_version(s: &str) -> Option<String> {
    s.split_whitespace().find(|tok| tok.chars().next().map_or(false, |c| c.is_ascii_digit()))
        .map(String::from)
}

async fn run_with_timeout(mut cmd: Command, secs: u64) -> Option<std::process::Output> {
    timeout(Duration::from_secs(secs), cmd.output()).await.ok().and_then(|r| r.ok())
}

pub async fn detect() -> Result<HermesDetectResult, AppError> {
    // 1. version
    let out = run_with_timeout(Command::new("hermes").arg("--version"), 5).await;
    let Some(out) = out else {
        return Ok(HermesDetectResult { installed: false, version: None, path: None, acp_ready: false, error: Some("hermes binary not found in PATH".into()) });
    };
    if !out.status.success() {
        return Ok(HermesDetectResult { installed: false, version: None, path: None, acp_ready: false, error: Some(String::from_utf8_lossy(&out.stderr).to_string()) });
    }
    let version_text = String::from_utf8_lossy(&out.stdout);
    let version = parse_version(&version_text);

    // 2. path via `which hermes`
    let path = run_with_timeout(Command::new("which").arg("hermes"), 2).await
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 3. acp ready
    let acp_out = run_with_timeout(Command::new("hermes").arg("acp").arg("--check"), 5).await;
    let acp_ready = acp_out.as_ref().map_or(false, |o| o.status.success());

    let error = if !acp_ready {
        acp_out.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string()).filter(|s| !s.is_empty())
    } else { None };

    Ok(HermesDetectResult { installed: true, version, path, acp_ready, error })
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_detect() -> Result<HermesDetectResult, AppError> {
    detect().await
}
```

- [ ] **Step 4: Wire module**

```rust
// src-tauri/src/hermes_agent/mod.rs
pub mod detect;
```

In `src-tauri/src/lib.rs`:
```rust
mod hermes_agent;
// in command list:
hermes_agent::detect::hermes_detect,
```

- [ ] **Step 5: Run unit test + build**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml hermes_agent::detect 2>&1 | tail -5
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: 3 tests passed, build clean.

- [ ] **Step 6: Regenerate bindings**

```bash
# project's bindings regen command (see docs/reference/commands.md)
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/hermes_agent/ src-tauri/src/lib.rs src-tauri/src/error.rs src/bindings.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(hermes): detect command (version + path + acp readiness)"
```

---

### Task B2: `HermesConnectionBlock` Settings UI

**Files:**
- Create: `src/components/settings/HermesConnectionBlock.tsx`
- Modify: same Settings render entry as Task A5

- [ ] **Step 1: Implement block**

```tsx
// src/components/settings/HermesConnectionBlock.tsx
import { useQuery } from "@tanstack/react-query";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

function unwrap<T>(r: any): T {
    if (r.status === "ok") return r.data;
    throw new Error(String(r.error));
}

export function HermesConnectionBlock() {
    const q = useQuery({
        queryKey: ["hermes-detect"],
        queryFn: async () => unwrap(await commands.hermesDetect()),
        staleTime: 60_000,
    });

    return (
        <section className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Hermes 연결</h3>
                <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
                    <RefreshCw className={q.isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                    <span className="ml-1">재감지</span>
                </Button>
            </div>

            {q.isLoading && <p className="text-xs text-muted-foreground">감지 중…</p>}
            {q.data && !q.data.installed && (
                <div className="flex items-start gap-2 text-sm text-red-600">
                    <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                        <p>Hermes를 찾을 수 없습니다.</p>
                        <p className="text-xs text-muted-foreground">설치 후 재감지하세요 (예: <code>pip install hermes-agent</code>).</p>
                    </div>
                </div>
            )}
            {q.data && q.data.installed && q.data.acp_ready && (
                <div className="flex items-start gap-2 text-sm text-green-700">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                        <p>Hermes {q.data.version ?? "(version?)"} 감지됨 · ACP 준비 완료</p>
                        {q.data.path && <p className="text-xs text-muted-foreground"><code>{q.data.path}</code></p>}
                    </div>
                </div>
            )}
            {q.data && q.data.installed && !q.data.acp_ready && (
                <div className="flex items-start gap-2 text-sm text-yellow-700">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                        <p>Hermes {q.data.version ?? ""} 감지됨이나 ACP 준비 미완.</p>
                        <p className="text-xs text-muted-foreground">터미널에서 <code>hermes acp --setup</code> 실행 후 재감지하세요.</p>
                        {q.data.error && <p className="text-xs text-muted-foreground mt-1">{q.data.error}</p>}
                    </div>
                </div>
            )}
        </section>
    );
}
```

- [ ] **Step 2: Mount adjacent to `HermesPanelSettings`**

In the same Settings render entry, add `<HermesConnectionBlock />` above `<HermesPanelSettings />`.

- [ ] **Step 3: Smoke**

```bash
pnpm tauri dev
```

Open Settings → see green ✓ + version + path. Click "재감지" — spinner + same result. (To test miss path: temporarily rename `~/.local/bin/hermes`.)

- [ ] **Step 4: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/components/settings/HermesConnectionBlock.tsx
git add -u src/  # picks up the Settings view modified in Step 2
git commit -m "feat(hermes): settings connection block (detect + acp ready)"
```

---

## Phase C — Rust ACP Client (Backend Only)

Outcome: `hermes acp` child process spawned/managed; LSP-framed JSON-RPC pump; `initialize` + `session/new` handshake; `session/prompt` with text + image; streaming `session/update` notifications fan out to Tauri events. UI unchanged.

> **Note on protocol details:** The exact ACP method names below (`initialize`, `session/new`, `session/prompt`, `session/update`) are the expected naming per the design spec but are subject to verification against the actual `hermes acp` wire format. Task C1 includes a discovery step.

### Task C1: Wire format discovery + LSP frame parser

**Files:**
- Create: `src-tauri/src/hermes_agent/frame.rs`
- Create: `src-tauri/src/hermes_agent/frame.rs` (with tests)

- [ ] **Step 1: Discover real ACP frame format**

Run a quick experiment to capture the actual `initialize` response from `hermes acp`:

```bash
echo 'Content-Length: 62\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | hermes acp 2>/tmp/hermes-acp-err | head -c 500 > /tmp/hermes-acp-out
xxd /tmp/hermes-acp-out | head -10
cat /tmp/hermes-acp-err | head -20
```

Document the observed format (header style, method name shape) inline in this task as a comment block — if it differs from LSP-style or method names differ from the spec, **update Tasks C2-C5 accordingly before proceeding**. Do not skip this step.

- [ ] **Step 2: Write failing frame parser test**

```rust
// src-tauri/src/hermes_agent/frame.rs
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn parse_single_frame() {
        let bytes = b"Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}";
        let mut r = BufReader::new(&bytes[..]);
        let frame = read_frame(&mut r).await.unwrap();
        assert_eq!(frame, br#"{"jsonrpc":"2.0"}"#);
    }

    #[tokio::test]
    async fn parse_back_to_back_frames() {
        let bytes = b"Content-Length: 7\r\n\r\n{\"a\":1}Content-Length: 7\r\n\r\n{\"b\":2}";
        let mut r = BufReader::new(&bytes[..]);
        assert_eq!(&read_frame(&mut r).await.unwrap(), br#"{"a":1}"#);
        assert_eq!(&read_frame(&mut r).await.unwrap(), br#"{"b":2}"#);
    }

    #[test]
    fn encode_frame_format() {
        assert_eq!(&encode_frame(b"{\"x\":1}"), b"Content-Length: 7\r\n\r\n{\"x\":1}");
    }
}
```

- [ ] **Step 3: Implement frame parser**

```rust
// src-tauri/src/hermes_agent/frame.rs
use crate::error::AppError;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncBufRead};

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, AppError> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await
            .map_err(|e| AppError::HermesSpawnFailed(format!("read header: {e}")))?;
        if n == 0 {
            return Err(AppError::HermesSpawnFailed("eof reading headers".into()));
        }
        let trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.is_empty() { break; }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse::<usize>().ok();
        }
    }
    let len = content_length.ok_or_else(|| AppError::HermesSpawnFailed("missing Content-Length".into()))?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await
        .map_err(|e| AppError::HermesSpawnFailed(format!("read body: {e}")))?;
    Ok(buf)
}

pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}
```

- [ ] **Step 4: Test**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml hermes_agent::frame 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hermes_agent/frame.rs
git commit -m "feat(hermes): LSP-style frame parser for ACP"
```

---

### Task C2: ACP client — session lifecycle

**Files:**
- Create: `src-tauri/src/hermes_agent/acp_client.rs`
- Modify: `src-tauri/src/hermes_agent/mod.rs`
- Modify: `src-tauri/src/error.rs` (add `HermesAcpProtocol`, `HermesTimeout`)

- [ ] **Step 1: Add error variants**

```rust
// src-tauri/src/error.rs additions
#[error("hermes acp protocol: {0}")]
HermesAcpProtocol(String),
#[error("hermes timeout")]
HermesTimeout,
```

- [ ] **Step 2: Define types**

```rust
// src-tauri/src/hermes_agent/acp_client.rs
use crate::error::AppError;
use crate::hermes_agent::frame::{read_frame, encode_frame};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AcpCommand {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageTransport { FilePath, Base64 }

pub struct AcpSession {
    pub session_id: String,
    pub available_commands: Vec<AcpCommand>,
    pub image_transport: ImageTransport,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    next_id: Arc<AtomicU64>,
    child: Child,
}

#[derive(Serialize, Deserialize)]
struct RpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Json,
}

#[derive(Serialize, Deserialize)]
struct RpcNotification<'a> {
    jsonrpc: &'a str,
    method: &'a str,
    params: Json,
}
```

- [ ] **Step 3: Implement spawn + handshake**

```rust
impl AcpSession {
    pub async fn spawn(app: AppHandle) -> Result<Self, AppError> {
        let mut child = Command::new("hermes")
            .arg("acp")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| AppError::HermesSpawnFailed(e.to_string()))?;

        let stdin = child.stdin.take().ok_or_else(|| AppError::HermesSpawnFailed("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| AppError::HermesSpawnFailed("no stdout".into()))?;

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(32);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>> = Default::default();
        let next_id = Arc::new(AtomicU64::new(1));

        // writer task
        tokio::spawn(async move {
            let mut stdin: ChildStdin = stdin;
            while let Some(frame) = stdin_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() { break; }
                let _ = stdin.flush().await;
            }
        });

        // reader task
        let pending_r = pending.clone();
        let app_r = app.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let body = match read_frame(&mut reader).await {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = app_r.emit("hermes-agent:error", json!({ "kind": "frame", "message": e.to_string() }));
                        break;
                    }
                };
                let val: Json = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = app_r.emit("hermes-agent:error", json!({ "kind": "json", "message": e.to_string() }));
                        continue;
                    }
                };
                dispatch_incoming(&app_r, &pending_r, val).await;
            }
        });

        // build half-built session, then run initialize + session/new
        let session = AcpSession {
            session_id: String::new(),
            available_commands: vec![],
            image_transport: ImageTransport::FilePath,
            stdin_tx,
            pending,
            next_id,
            child,
        };

        // initialize
        let init = session.request("initialize", json!({})).await?;
        let _ = app.emit("hermes-agent:session-ready", json!({ "init": init }));

        // session/new
        let new_resp = session.request("session/new", json!({})).await?;
        let session_id = new_resp.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let commands_arr = new_resp.get("available_commands").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let available: Vec<AcpCommand> = commands_arr.into_iter().filter_map(|c| {
            let name = c.get("name")?.as_str()?.to_string();
            let description = c.get("description").and_then(|d| d.as_str()).map(String::from);
            Some(AcpCommand { name, description })
        }).collect();

        let _ = app.emit("hermes-agent:available-commands", json!({ "commands": &available }));

        Ok(AcpSession {
            session_id,
            available_commands: available,
            ..session
        })
    }

    pub async fn request(&self, method: &str, params: Json) -> Result<Json, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = RpcRequest { jsonrpc: "2.0", id, method, params };
        let body = serde_json::to_vec(&req).map_err(|e| AppError::HermesAcpProtocol(e.to_string()))?;
        let frame = encode_frame(&body);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        self.stdin_tx.send(frame).await.map_err(|_| AppError::HermesAcpProtocol("stdin closed".into()))?;

        let resp = timeout(Duration::from_secs(30), rx).await
            .map_err(|_| AppError::HermesTimeout)?
            .map_err(|_| AppError::HermesAcpProtocol("response dropped".into()))?;

        if let Some(err) = resp.get("error") {
            return Err(AppError::HermesAcpProtocol(err.to_string()));
        }
        Ok(resp.get("result").cloned().unwrap_or(Json::Null))
    }

    pub async fn notify(&self, method: &str, params: Json) -> Result<(), AppError> {
        let n = RpcNotification { jsonrpc: "2.0", method, params };
        let body = serde_json::to_vec(&n).map_err(|e| AppError::HermesAcpProtocol(e.to_string()))?;
        self.stdin_tx.send(encode_frame(&body)).await.map_err(|_| AppError::HermesAcpProtocol("stdin closed".into()))
    }

    pub async fn kill(mut self) {
        let _ = self.child.kill().await;
    }
}

async fn dispatch_incoming(
    app: &AppHandle,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    val: Json,
) {
    // response (has "id")
    if let Some(id) = val.get("id").and_then(|v| v.as_u64()) {
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(val);
            return;
        }
    }
    // notification — dispatch by method
    if let Some(method) = val.get("method").and_then(|v| v.as_str()) {
        let params = val.get("params").cloned().unwrap_or(Json::Null);
        match method {
            "session/update" => {
                // params: { turn_id, kind: "chunk"|"tool_call"|"end", text?, name?, args?, status? }
                let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let evt = match kind {
                    "chunk" => "hermes-agent:chunk",
                    "tool_call" => "hermes-agent:tool-call",
                    "end" => "hermes-agent:turn-end",
                    _ => "hermes-agent:error",
                };
                let _ = app.emit(evt, &params);
            }
            _ => {
                let _ = app.emit("hermes-agent:error", json!({ "kind": "unknown_method", "method": method }));
            }
        }
    }
}
```

> **NOTE:** The exact `session/update` payload shape (the `kind` discriminator vs. distinct method names like `session/update/chunk`) must be confirmed against the live ACP output captured in C1 Step 1. If the discriminator is named differently or methods are split, adjust `dispatch_incoming` to match before proceeding.

- [ ] **Step 4: Build**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10
```

Expected: clean. If `AppError` constructors differ, adjust.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hermes_agent/acp_client.rs src-tauri/src/hermes_agent/mod.rs src-tauri/src/error.rs
git commit -m "feat(hermes): ACP session — spawn + handshake + request/notify"
```

---

### Task C3: IPC commands for agent lifecycle + send

**Files:**
- Create: `src-tauri/src/commands/hermes_agent.rs`
- Modify: `src-tauri/src/lib.rs` (state + register)
- Modify: `src-tauri/src/hermes_agent/mod.rs` (export `AcpSession`)

- [ ] **Step 1: State holder**

In `src-tauri/src/hermes_agent/mod.rs`:

```rust
pub mod detect;
pub mod frame;
pub mod acp_client;

use tokio::sync::Mutex;
use std::sync::Arc;

pub type HermesAgentHolder = Arc<Mutex<Option<acp_client::AcpSession>>>;

pub fn new_holder() -> HermesAgentHolder { Arc::new(Mutex::new(None)) }
```

In `src-tauri/src/lib.rs` `setup`:

```rust
let hermes_holder = hermes_agent::new_holder();
app.manage(hermes_holder);
```

- [ ] **Step 2: Commands**

```rust
// src-tauri/src/commands/hermes_agent.rs
use crate::error::AppError;
use crate::hermes_agent::{HermesAgentHolder, acp_client::AcpSession};
use serde_json::json;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_start(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
) -> Result<(), AppError> {
    let mut guard = holder.lock().await;
    if guard.is_some() {
        return Ok(()); // idempotent
    }
    let session = AcpSession::spawn(app.clone()).await?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    holder: State<'_, HermesAgentHolder>,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    let guard = holder.lock().await;
    let session = guard.as_ref().ok_or_else(|| AppError::HermesAcpProtocol("session not started".into()))?;

    let mut prompt = vec![json!({ "type": "text", "text": text })];
    for path in &image_paths {
        let block = match session.image_transport {
            crate::hermes_agent::acp_client::ImageTransport::FilePath =>
                json!({ "type": "image", "source": { "type": "file", "path": path } }),
            crate::hermes_agent::acp_client::ImageTransport::Base64 => {
                let bytes = tokio::fs::read(path).await.map_err(|e| AppError::HermesAcpProtocol(format!("read image: {e}")))?;
                let b64 = base64_simd::STANDARD.encode_to_string(bytes); // or `base64::engine::general_purpose::STANDARD.encode`
                let media_type = mime_from_ext(path);
                json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": b64 } })
            }
        };
        prompt.push(block);
    }

    let params = json!({ "session_id": session.session_id, "prompt": prompt });
    session.notify("session/prompt", params).await
}

fn mime_from_ext(path: &str) -> &'static str {
    match path.to_lowercase().split('.').last().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_cancel(holder: State<'_, HermesAgentHolder>) -> Result<(), AppError> {
    let guard = holder.lock().await;
    if let Some(session) = guard.as_ref() {
        session.notify("session/cancel", json!({ "session_id": session.session_id })).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_stop(holder: State<'_, HermesAgentHolder>) -> Result<(), AppError> {
    let mut guard = holder.lock().await;
    if let Some(session) = guard.take() {
        session.kill().await;
    }
    Ok(())
}
```

Choose a base64 crate already in `Cargo.toml` — `rg "^base64" src-tauri/Cargo.toml`. Likely `base64 = "0.22"`; use `base64::engine::general_purpose::STANDARD.encode(&bytes)`.

- [ ] **Step 3: Register**

```rust
// src-tauri/src/lib.rs commands list
commands::hermes_agent::hermes_agent_start,
commands::hermes_agent::hermes_agent_send,
commands::hermes_agent::hermes_agent_cancel,
commands::hermes_agent::hermes_agent_stop,
```

In `src-tauri/src/commands/mod.rs`:
```rust
pub mod hermes_agent;
```

- [ ] **Step 4: Build + regenerate bindings**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
# bindings regen
```

- [ ] **Step 5: Manual smoke (Rust side only)**

Run app, open devtools console, then:

```js
await window.__TAURI__.core.invoke("hermes_agent_start");
await window.__TAURI__.core.invoke("hermes_agent_send", { text: "ping", imagePaths: [] });
```

Open native terminal `tail -f` on stderr (Tauri logs hermes child stderr if you wired it — optional). Confirm no errors thrown.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/hermes_agent.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/hermes_agent/mod.rs src/bindings.ts
git commit -m "feat(hermes): IPC commands for ACP session lifecycle + send"
```

---

### Task C4: Pasted image temp file command

**Files:**
- Add to: `src-tauri/src/commands/hermes_agent.rs`

- [ ] **Step 1: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_save_pasted_image(bytes: Vec<u8>, ext: String) -> Result<String, AppError> {
    let safe_ext = match ext.to_lowercase().as_str() {
        "png"|"jpg"|"jpeg"|"gif"|"webp" => ext.to_lowercase(),
        _ => "png".to_string(),
    };
    let id = uuid::Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("hermes-paste-{}.{}", id, safe_ext));
    tokio::fs::write(&path, &bytes).await.map_err(|e| AppError::HermesAcpProtocol(format!("write: {e}")))?;

    // schedule cleanup 5min later
    let p = path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        let _ = tokio::fs::remove_file(p).await;
    });

    Ok(path.to_string_lossy().to_string())
}
```

If `uuid` isn't in `Cargo.toml`, add it: `uuid = { version = "1", features = ["v4"] }`.

- [ ] **Step 2: Register + bindings + commit**

```rust
// commands list
commands::hermes_agent::hermes_save_pasted_image,
```

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3
# regenerate bindings
git add src-tauri/ src/bindings.ts
git commit -m "feat(hermes): hermes_save_pasted_image temp file command"
```

---

## Phase D — Wire Panel to ACP (Real Chat)

Outcome: Open panel → auto-starts ACP session if Hermes detected → typing + Enter sends a turn → assistant chunks stream into the log → turn-end finalizes. "New session" button restarts. Errors render as system messages.

### Task D1: `useHermesAgent` hook

**Files:**
- Create: `src/components/hermes/types.ts`
- Create: `src/components/hermes/useHermesAgent.ts`

- [ ] **Step 1: Message types**

```ts
// src/components/hermes/types.ts
export type ToolCallSummary = { name: string; args_summary?: string };

export type HermesMessage =
    | { id: string; role: "user"; text: string; images: string[]; ts: number }
    | { id: string; role: "assistant"; chunks: string[]; toolCalls: ToolCallSummary[]; ts: number; done: boolean }
    | { id: string; role: "system"; text: string; level: "info" | "warn" | "error"; ts: number };

export type SessionStatus = "idle" | "starting" | "ready" | "error";
```

- [ ] **Step 2: Hook**

```ts
// src/components/hermes/useHermesAgent.ts
import { useEffect, useReducer, useState, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type AcpCommand } from "@/bindings";
import type { HermesMessage, SessionStatus } from "./types";

function unwrap<T>(r: any): T {
    if (r.status === "ok") return r.data;
    throw new Error(String(r.error));
}

type Action =
    | { type: "user"; text: string; images: string[] }
    | { type: "assistant-chunk"; text: string }
    | { type: "assistant-tool"; name: string; args_summary?: string }
    | { type: "assistant-end"; status: string; error?: string }
    | { type: "system"; text: string; level: "info"|"warn"|"error" }
    | { type: "reset" };

const uid = () => crypto.randomUUID();

function reducer(state: HermesMessage[], a: Action): HermesMessage[] {
    if (a.type === "reset") return [];
    if (a.type === "user") return [...state, { id: uid(), role: "user", text: a.text, images: a.images, ts: Date.now() }];
    if (a.type === "system") return [...state, { id: uid(), role: "system", text: a.text, level: a.level, ts: Date.now() }];

    const last = state[state.length - 1];
    const ensureAssistant = (): HermesMessage[] => {
        if (last && last.role === "assistant" && !last.done) return state;
        return [...state, { id: uid(), role: "assistant", chunks: [], toolCalls: [], ts: Date.now(), done: false }];
    };

    if (a.type === "assistant-chunk") {
        const s = ensureAssistant();
        const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
        return [...s.slice(0, -1), { ...lastA, chunks: [...lastA.chunks, a.text] }];
    }
    if (a.type === "assistant-tool") {
        const s = ensureAssistant();
        const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
        return [...s.slice(0, -1), { ...lastA, toolCalls: [...lastA.toolCalls, { name: a.name, args_summary: a.args_summary }] }];
    }
    if (a.type === "assistant-end") {
        const s = ensureAssistant();
        const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
        const next = [...s.slice(0, -1), { ...lastA, done: true }];
        if (a.status !== "ok") {
            return [...next, { id: uid(), role: "system", text: a.error ?? `turn ${a.status}`, level: "warn", ts: Date.now() }];
        }
        return next;
    }
    return state;
}

export function useHermesAgent() {
    const [messages, dispatch] = useReducer(reducer, []);
    const [status, setStatus] = useState<SessionStatus>("idle");
    const [commandsList, setCommandsList] = useState<AcpCommand[]>([]);

    // subscribe events
    useEffect(() => {
        const unlistens: UnlistenFn[] = [];
        const sub = async () => {
            unlistens.push(await listen<{ text: string }>("hermes-agent:chunk", (e) =>
                dispatch({ type: "assistant-chunk", text: e.payload.text ?? "" })));
            unlistens.push(await listen<{ name: string; args_summary?: string }>("hermes-agent:tool-call", (e) =>
                dispatch({ type: "assistant-tool", name: e.payload.name, args_summary: e.payload.args_summary })));
            unlistens.push(await listen<{ status: string; error?: string }>("hermes-agent:turn-end", (e) =>
                dispatch({ type: "assistant-end", status: e.payload.status, error: e.payload.error })));
            unlistens.push(await listen<{ commands: AcpCommand[] }>("hermes-agent:available-commands", (e) =>
                setCommandsList(e.payload.commands)));
            unlistens.push(await listen("hermes-agent:session-ready", () => setStatus("ready")));
            unlistens.push(await listen<{ kind: string; message: string }>("hermes-agent:error", (e) => {
                setStatus("error");
                dispatch({ type: "system", text: `Hermes 오류: ${e.payload.message}`, level: "error" });
            }));
        };
        sub();
        return () => { unlistens.forEach((u) => u()); };
    }, []);

    const start = useCallback(async () => {
        if (status === "ready" || status === "starting") return;
        setStatus("starting");
        try {
            unwrap(await commands.hermesAgentStart());
        } catch (e) {
            setStatus("error");
            dispatch({ type: "system", text: `시작 실패: ${(e as Error).message}`, level: "error" });
        }
    }, [status]);

    const send = useCallback(async (text: string, images: string[] = []) => {
        if (!text.trim() && images.length === 0) return;
        dispatch({ type: "user", text, images });
        try {
            unwrap(await commands.hermesAgentSend(text, images));
        } catch (e) {
            dispatch({ type: "system", text: `송신 실패: ${(e as Error).message}`, level: "error" });
        }
    }, []);

    const cancel = useCallback(async () => { await commands.hermesAgentCancel(); }, []);

    const restart = useCallback(async () => {
        await commands.hermesAgentStop();
        dispatch({ type: "reset" });
        setStatus("idle");
        await start();
    }, [start]);

    return { messages, status, commandsList, start, send, cancel, restart };
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add src/components/hermes/types.ts src/components/hermes/useHermesAgent.ts
git commit -m "feat(hermes): useHermesAgent hook — events + dispatch + actions"
```

---

### Task D2: `HermesChatLog` rendering

**Files:**
- Create: `src/components/hermes/HermesChatLog.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/hermes/HermesChatLog.tsx
import { useEffect, useRef } from "react";
import type { HermesMessage } from "./types";
import { cn } from "@/lib/utils";

interface Props { messages: HermesMessage[] }

export function HermesChatLog({ messages }: Props) {
    const endRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(true);

    useEffect(() => {
        if (followRef.current) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, [messages]);

    return (
        <div
            className="flex-1 overflow-auto px-4 py-3 space-y-3"
            onScroll={(e) => {
                const el = e.currentTarget;
                followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
        >
            {messages.map((m) => (
                <div key={m.id} className={cn(
                    "text-sm",
                    m.role === "user" && "text-right",
                )}>
                    {m.role === "user" && (
                        <div className="inline-block max-w-[85%] rounded-md bg-primary/10 px-3 py-2 text-left">
                            <p className="whitespace-pre-wrap break-words">{m.text}</p>
                            {m.images.length > 0 && (
                                <p className="text-xs text-muted-foreground mt-1">📎 {m.images.length} image{m.images.length>1?"s":""}</p>
                            )}
                        </div>
                    )}
                    {m.role === "assistant" && (
                        <div className="rounded-md bg-muted px-3 py-2">
                            {m.toolCalls.map((t, i) => (
                                <details key={i} className="text-xs mb-1">
                                    <summary className="cursor-pointer text-muted-foreground">⚙ {t.name}</summary>
                                    {t.args_summary && <pre className="text-xs mt-1 whitespace-pre-wrap">{t.args_summary}</pre>}
                                </details>
                            ))}
                            <p className="whitespace-pre-wrap break-words">{m.chunks.join("")}</p>
                            {!m.done && <span className="ml-1 inline-block animate-pulse">▍</span>}
                        </div>
                    )}
                    {m.role === "system" && (
                        <p className={cn(
                            "text-xs",
                            m.level === "error" && "text-red-600",
                            m.level === "warn" && "text-yellow-700",
                            m.level === "info" && "text-muted-foreground",
                        )}>
                            {m.text}
                        </p>
                    )}
                </div>
            ))}
            <div ref={endRef} />
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hermes/HermesChatLog.tsx
git commit -m "feat(hermes): chat log render — streaming + tool calls"
```

---

### Task D3: Minimal `HermesChatInput` (text only, for now)

**Files:**
- Create: `src/components/hermes/HermesChatInput.tsx`

- [ ] **Step 1: Implement (text-only; slash + images added in Phase E)**

```tsx
// src/components/hermes/HermesChatInput.tsx
import { useState, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

interface Props {
    onSend: (text: string, images: string[]) => void;
    disabled?: boolean;
}

export function HermesChatInput({ onSend, disabled }: Props) {
    const [text, setText] = useState("");

    const submit = useCallback(() => {
        if (!text.trim()) return;
        onSend(text, []);
        setText("");
    }, [text, onSend]);

    return (
        <div className="border-t p-3 flex items-end gap-2">
            <Textarea
                className="flex-1 min-h-[40px] max-h-[200px] resize-none"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                }}
                placeholder="메시지… (Shift+Enter 줄바꿈)"
                disabled={disabled}
            />
            <Button size="icon" onClick={submit} disabled={disabled || !text.trim()}>
                <Send className="h-4 w-4" />
            </Button>
        </div>
    );
}
```

`Textarea` from `src/components/ui/textarea.tsx` — if missing, add via shadcn convention.

- [ ] **Step 2: Commit**

```bash
git add src/components/hermes/HermesChatInput.tsx
git commit -m "feat(hermes): chat input (text only)"
```

---

### Task D4: Wire `HermesView` to use chat

**Files:**
- Modify: `src/components/HermesView.tsx`
- Modify: `src/components/hermes/HermesPanel.tsx` (auto-start + restart button in header)

- [ ] **Step 1: New `HermesView`**

```tsx
// src/components/HermesView.tsx
import { useEffect } from "react";
import { HermesPanel } from "./hermes/HermesPanel";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesChatInput } from "./hermes/HermesChatInput";
import { useHermesAgent } from "./hermes/useHermesAgent";

export default function HermesView() {
    const agent = useHermesAgent();

    useEffect(() => { agent.start(); }, []);

    return (
        <HermesPanel onRestart={agent.restart}>
            <div className="flex flex-1 flex-col min-h-0">
                <HermesChatLog messages={agent.messages} />
                <HermesChatInput onSend={agent.send} disabled={agent.status !== "ready"} />
            </div>
        </HermesPanel>
    );
}
```

- [ ] **Step 2: Add `onRestart` button to `HermesPanel` header**

In `HermesPanel.tsx`, extend Props:

```tsx
interface Props {
    children: React.ReactNode;
    onRestart?: () => void;
}
```

In header (next to X button):

```tsx
{onRestart && (
    <Button data-no-drag variant="ghost" size="icon" className="h-6 w-6" onClick={onRestart} aria-label="새 세션">
        <RotateCcw className="h-4 w-4" />
    </Button>
)}
```

Import `RotateCcw` from `lucide-react`.

- [ ] **Step 3: Manual smoke**

```bash
pnpm tauri dev
```

- Panel opens via hotkey.
- Type "hello" + Enter → user bubble appears.
- Assistant bubble streams chunks.
- Click restart → log clears, new session.

- [ ] **Step 4: Commit**

```bash
git add src/components/HermesView.tsx src/components/hermes/HermesPanel.tsx
git commit -m "feat(hermes): wire panel to ACP chat (streaming + restart)"
```

---

## Phase E — Slash Commands + Image Input

### Task E1: Slash menu

**Files:**
- Create: `src/components/hermes/HermesSlashMenu.tsx`
- Modify: `src/components/hermes/HermesChatInput.tsx`

- [ ] **Step 1: Slash menu**

```tsx
// src/components/hermes/HermesSlashMenu.tsx
import { useEffect, useRef } from "react";
import type { AcpCommand } from "@/bindings";
import { cn } from "@/lib/utils";

interface Props {
    items: AcpCommand[];
    activeIdx: number;
    onPick: (cmd: AcpCommand) => void;
    onHover: (idx: number) => void;
}

export function HermesSlashMenu({ items, activeIdx, onPick, onHover }: Props) {
    const ref = useRef<HTMLUListElement>(null);
    useEffect(() => {
        const li = ref.current?.children[activeIdx] as HTMLElement | undefined;
        li?.scrollIntoView({ block: "nearest" });
    }, [activeIdx]);

    if (items.length === 0) return null;
    return (
        <ul ref={ref} className="absolute bottom-full left-3 right-3 mb-2 max-h-56 overflow-auto rounded-md border bg-popover shadow-md text-sm">
            {items.map((c, i) => (
                <li
                    key={c.name}
                    className={cn("px-3 py-1.5 cursor-pointer", i === activeIdx && "bg-accent")}
                    onMouseEnter={() => onHover(i)}
                    onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
                >
                    <span className="font-mono">/{c.name}</span>
                    {c.description && <span className="ml-2 text-xs text-muted-foreground">{c.description}</span>}
                </li>
            ))}
        </ul>
    );
}
```

- [ ] **Step 2: Extend `HermesChatInput` with slash detection**

```tsx
// src/components/hermes/HermesChatInput.tsx (full replacement)
import { useState, useCallback, useMemo, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";
import type { AcpCommand } from "@/bindings";
import { HermesSlashMenu } from "./HermesSlashMenu";

interface Props {
    onSend: (text: string, images: string[]) => void;
    disabled?: boolean;
    commandsList: AcpCommand[];
}

function detectSlash(text: string, caret: number): { active: boolean; query: string; start: number } {
    // find token from caret backwards delimited by whitespace
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    const start = i + 1;
    const token = text.slice(start, caret);
    return token.startsWith("/")
        ? { active: true, query: token.slice(1), start }
        : { active: false, query: "", start: -1 };
}

export function HermesChatInput({ onSend, disabled, commandsList }: Props) {
    const [text, setText] = useState("");
    const [caret, setCaret] = useState(0);
    const [activeIdx, setActiveIdx] = useState(0);
    const taRef = useRef<HTMLTextAreaElement>(null);

    const slash = useMemo(() => detectSlash(text, caret), [text, caret]);
    const filtered = useMemo(
        () => commandsList.filter((c) => c.name.toLowerCase().startsWith(slash.query.toLowerCase())),
        [commandsList, slash.query],
    );
    const menuOpen = slash.active && filtered.length > 0;

    const pickSlash = useCallback((cmd: AcpCommand) => {
        const before = text.slice(0, slash.start);
        const after = text.slice(caret);
        const inserted = `/${cmd.name} `;
        const nextText = before + inserted + after;
        setText(nextText);
        const newCaret = (before + inserted).length;
        requestAnimationFrame(() => {
            taRef.current?.focus();
            taRef.current?.setSelectionRange(newCaret, newCaret);
            setCaret(newCaret);
        });
        setActiveIdx(0);
    }, [text, caret, slash.start]);

    const submit = useCallback(() => {
        if (!text.trim()) return;
        onSend(text, []);
        setText("");
    }, [text, onSend]);

    return (
        <div className="relative border-t p-3 flex items-end gap-2">
            {menuOpen && (
                <HermesSlashMenu
                    items={filtered}
                    activeIdx={activeIdx}
                    onPick={pickSlash}
                    onHover={setActiveIdx}
                />
            )}
            <Textarea
                ref={taRef}
                className="flex-1 min-h-[40px] max-h-[200px] resize-none"
                value={text}
                onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
                onKeyDown={(e) => {
                    if (menuOpen) {
                        if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); return; }
                        if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
                        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(filtered[activeIdx]); return; }
                        if (e.key === "Escape") { e.preventDefault(); setCaret(-1); return; }
                    }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                }}
                onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                placeholder="메시지 (/ 입력 시 명령 목록)"
                disabled={disabled}
            />
            <Button size="icon" onClick={submit} disabled={disabled || !text.trim()}>
                <Send className="h-4 w-4" />
            </Button>
        </div>
    );
}
```

- [ ] **Step 3: Pass `commandsList` from `HermesView`**

In `HermesView.tsx`:

```tsx
<HermesChatInput onSend={agent.send} disabled={agent.status !== "ready"} commandsList={agent.commandsList} />
```

- [ ] **Step 4: Manual smoke**

Open panel → type `/` → menu appears with hermes commands. ↑↓ navigate. Tab/Enter inserts. Esc dismisses.

- [ ] **Step 5: Commit**

```bash
git add src/components/hermes/HermesSlashMenu.tsx src/components/hermes/HermesChatInput.tsx src/components/HermesView.tsx
git commit -m "feat(hermes): slash command menu from ACP available_commands"
```

---

### Task E2: Image paste / drop / file picker

**Files:**
- Modify: `src/components/hermes/HermesChatInput.tsx`

- [ ] **Step 1: Add attachments state + handlers**

Inside `HermesChatInput` (above return):

```tsx
const [attachments, setAttachments] = useState<string[]>([]);

const saveBytes = useCallback(async (bytes: Uint8Array, ext: string): Promise<string | null> => {
    try {
        const r = await commands.hermesSavePastedImage(Array.from(bytes), ext);
        if (r.status !== "ok") throw new Error(String(r.error));
        return r.data;
    } catch { return null; }
}, []);

const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (!blob) continue;
            const ab = await blob.arrayBuffer();
            const ext = item.type.split("/")[1] ?? "png";
            const path = await saveBytes(new Uint8Array(ab), ext);
            if (path) setAttachments((a) => [...a, path]);
        }
    }
}, [saveBytes]);

const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) {
        if (!file.type.startsWith("image/")) continue;
        const ab = await file.arrayBuffer();
        const ext = file.name.split(".").pop() ?? "png";
        const path = await saveBytes(new Uint8Array(ab), ext);
        if (path) setAttachments((a) => [...a, path]);
    }
}, [saveBytes]);

const pickFile = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ multiple: true, filters: [{ name: "Images", extensions: ["png","jpg","jpeg","gif","webp"] }] });
    const paths = Array.isArray(result) ? result : result ? [result] : [];
    setAttachments((a) => [...a, ...paths]);
}, []);
```

Add `import { commands } from "@/bindings";` and `import { Paperclip, X } from "lucide-react";` at top.

- [ ] **Step 2: Submit consumes + clears attachments**

```tsx
const submit = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
}, [text, attachments, onSend]);
```

- [ ] **Step 3: Render preview chips + drop zone + picker button**

Replace the outer container in the return:

```tsx
<div
    className="relative border-t p-3 flex flex-col gap-2"
    onDragOver={(e) => e.preventDefault()}
    onDrop={onDrop}
>
    {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
            {attachments.map((p, i) => (
                <span key={p} className="inline-flex items-center gap-1 text-xs bg-muted rounded px-2 py-0.5">
                    📎 {p.split("/").pop()}
                    <button onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))} aria-label="remove">
                        <X className="h-3 w-3" />
                    </button>
                </span>
            ))}
        </div>
    )}
    <div className="flex items-end gap-2">
        {menuOpen && (
            <HermesSlashMenu items={filtered} activeIdx={activeIdx} onPick={pickSlash} onHover={setActiveIdx} />
        )}
        <Button data-no-drag size="icon" variant="ghost" onClick={pickFile} aria-label="이미지 첨부">
            <Paperclip className="h-4 w-4" />
        </Button>
        <Textarea
            ref={taRef}
            className="flex-1 min-h-[40px] max-h-[200px] resize-none"
            value={text}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
            onPaste={onPaste}
            onKeyDown={/* unchanged */}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            placeholder="메시지 · / 명령 · 이미지 paste/drop"
            disabled={disabled}
        />
        <Button size="icon" onClick={submit} disabled={disabled || (!text.trim() && attachments.length === 0)}>
            <Send className="h-4 w-4" />
        </Button>
    </div>
</div>
```

- [ ] **Step 4: Manual smoke**

- Cmd+V a screenshot → preview chip appears → submit → user message shows attachment count → assistant responds about the image.
- Drag a PNG from Finder onto the input area → chip appears.
- Click paperclip → file picker → image added.
- Remove a chip with its X button.

- [ ] **Step 5: Commit**

```bash
git add src/components/hermes/HermesChatInput.tsx
git commit -m "feat(hermes): image paste / drag-drop / file picker"
```

---

## Final verification

- [ ] **Full project gates**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --manifest-path src-tauri/Cargo.toml --check
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
pnpm typecheck
pnpm lint
pnpm vitest run
```

Expected: all green.

- [ ] **specta drift check**

```bash
# project's bindings drift check command
```

Expected: no drift.

- [ ] **End-to-end manual checklist** (record in PR body)

- [ ] Hotkey toggle 5x
- [ ] Drag and resize, restart → position restored
- [ ] Settings: change hotkey to `Cmd+Alt+H`, confirm new key works
- [ ] Settings: with `hermes` PATH missing, connection block shows ✗
- [ ] Send "ping" → assistant streams response
- [ ] `/` opens menu, Tab inserts command
- [ ] Cmd+V screenshot → chip → submit → image arrives in hermes
- [ ] Cancel mid-turn via restart button

- [ ] **Final commit (CHANGELOG / docs/decisions.md)**

```bash
# Update docs/decisions.md with a one-liner referencing the spec + ADR if needed
git add docs/decisions.md
git commit -m "docs(decisions): hermes floating panel + ACP integration"
```

- [ ] **Rebase one more time onto origin/dev and push**

```bash
git fetch origin dev
git rebase origin/dev
PATH="$HOME/.cargo/bin:$PATH" git push -u origin feat/hermes-floating
```

Open PR with checklist from spec §11 (INVARIANTS) + §10 (Verification) + manual smoke evidence.

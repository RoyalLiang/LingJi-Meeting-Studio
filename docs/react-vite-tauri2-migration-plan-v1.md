> 历史文档（2026-10-11 整理）：首版方向已改为浏览器优先、尽量免安装。本文保留原有设计背景，不作为当前实现或排期承诺；先读 [新文档入口](README.md) 与 [当前状态](engineering/current-state.md)。

# React + Vite + Tauri 2 Migration Plan v1

- Status: Draft
- Updated: 2026-03-22
- Scope: Desktop-first architecture migration, with iOS readiness preserved

## 1. Executive Summary

This migration plan moves the project from the current `Node + raw HTML shell preview` to a formal desktop architecture based on:

- `React 19`
- `TypeScript`
- `Vite`
- `Tauri 2`

The plan is intentionally split into two layers:

1. UI migration
   - Move all desktop shell UI from raw DOM code to React components and typed state.
2. Runtime migration
   - Wrap the new React app in Tauri 2 and progressively move desktop-only capabilities into Tauri commands/plugins.

This separation is important.

The highest-confidence first move is not "rewrite everything into Rust/Tauri", but:

- keep current Node services working
- replace the raw shell with a React shell
- then attach Tauri runtime capabilities in controlled phases

## 2. Why This Route

## 2.1 Why React + Vite

Current desktop shell complexity is already beyond safe raw DOM maintenance:

- large `shell.js`
- large `shell.html`
- multi-surface state
- replay, preview, audio, i18n, folders, live capture, overlay

React solves the immediate problem:

- component boundaries
- local state ownership
- controlled render flow
- composable feature modules
- easier testing and incremental refactor

Vite is the correct build tool because:

- no SSR requirement exists
- fast local dev
- clean React + TS path
- easy Tauri integration

## 2.2 Why Tauri 2

Tauri 2 is chosen for the desktop runtime because it gives us:

- smaller runtime footprint than Electron
- modern desktop shell model
- strong permissions/capability boundary
- frontend independence
- mobile-aware roadmap

But this plan does not assume Tauri can solve every audio problem on day 1.

The strategy is:

- use Tauri for shell/runtime/window/system integration first
- preserve current service architecture
- introduce native audio plugins only where web APIs stop being sufficient

## 2.3 What We Are Not Doing

This plan does not include:

- rewriting Node services into Rust
- merging desktop and iOS into a single UI codebase immediately
- building offline/local-first sidecars in phase 1
- redesigning the product domain model from scratch

## 3. Migration Goals

The migration must achieve these goals:

1. Replace the raw desktop shell with maintainable React feature modules.
2. Keep `session-gateway`, `transcript-api`, and `ai-worker` usable during migration.
3. Introduce Tauri runtime capabilities without breaking the live transcript chain.
4. Preserve future iOS optionality.
5. Make audio capture architecture evolvable, especially for Windows system audio.

## 4. Architecture Principles

## 4.1 Service Layer Stays Stable

Existing backend services remain the product backbone:

- `services/session-gateway`
- `services/transcript-api`
- `services/ai-worker`

Desktop migration should consume their APIs rather than re-invent them.

## 4.2 Frontend State Must Be Layered

The new desktop frontend must separate:

- server state
  - sessions, replay payloads, summaries, share links
- realtime state
  - SSE stream envelopes, live transcript progression, latency values
- UI state
  - drawers, dialogs, selected session, replay search, overlay mode
- device/capture state
  - microphone permission, device list, recording engine, queue status

## 4.3 Tauri-Specific Logic Must Not Leak Everywhere

All Tauri-specific APIs must live behind a bridge layer.

React feature code should depend on interfaces like:

- `DesktopRuntime`
- `OverlayWindowService`
- `ShortcutService`
- `CaptureRuntime`
- `SidecarRuntime`

This keeps the app testable in browser preview mode and preserves future iOS optionality.

## 5. Target Repository Shape

Recommended target structure:

```text
apps/
  desktop/
    src/
      main.tsx
      app/
        App.tsx
        router.tsx
        providers.tsx
      features/
        sessions/
        folders/
        live/
        replay/
        audio/
        overlay/
        settings/
      components/
      hooks/
      lib/
        api/
        runtime/
        state/
        i18n/
        utils/
      styles/
    src-tauri/
      Cargo.toml
      tauri.conf.json
      capabilities/
      permissions/
      src/
        main.rs
        commands/
        runtime/
        windows/
        state/
        plugins/
  web/
    src/
      main.tsx
      viewer/
      admin/
packages/
  shared-types/
  domain/
  api-client/
  desktop-bridge/
  ui/
```

## 5.1 Package Responsibilities

### `packages/shared-types`

Keep and expand current cross-service contracts:

- session
- segment
- translation
- summary
- audio clip
- realtime envelope

### `packages/domain`

New package for framework-agnostic domain logic:

- replay shaping
- session display helpers
- transcript alignment helpers
- title suggestion heuristics
- language normalization

### `packages/api-client`

New package for typed network access:

- transcript API client
- gateway client
- SSE adapter
- payload validation

### `packages/desktop-bridge`

New package for desktop runtime interfaces:

- Tauri adapters
- browser fallback adapters
- command/event type contracts

### `packages/ui`

Optional shared React component package for:

- chips
- dialog shells
- timeline controls
- session cards
- audio cards

## 6. Frontend Stack Decisions

Recommended libraries:

- `react`
- `react-dom`
- `typescript`
- `vite`
- `react-router-dom`
- `zustand`
- `@tanstack/react-query`
- `zod`
- `tailwindcss`
- `clsx`

## 6.1 Why This Specific Combination

### React Router

Use for app surfaces:

- `/`
- `/folders`
- `/history`
- `/live/:sessionId`
- `/replay/:sessionId`
- `/overlay/:sessionId`

### Zustand

Use for client-only and realtime state:

- active drawer
- selected session
- replay query
- current live transcript state
- capture queue state
- overlay preferences

### React Query

Use for server state:

- sessions list
- replay payload
- summary payload
- share links

### Zod

Use at boundaries:

- server response validation
- Tauri command payload validation
- runtime event payload validation

### Tailwind

Keep existing styling investment.

Do not rewrite styling philosophy during the runtime migration.

## 7. Tauri 2 Runtime Architecture

## 7.1 Tauri Responsibilities

Tauri should own desktop-native concerns:

- window lifecycle
- overlay window creation
- always-on-top behavior
- tray integration
- global shortcuts
- local settings storage
- secure command boundary
- future sidecar orchestration

## 7.2 What Stays In The Web Layer Initially

In phase 1 and phase 2, the webview layer still handles:

- microphone permission flow
- `navigator.mediaDevices`
- `AudioContext`
- `AudioWorklet`
- chunk generation
- fetch / SSE

This reduces migration risk dramatically.

## 7.3 Tauri Commands

Initial command surface should stay small:

- `app_get_version`
- `settings_load`
- `settings_save`
- `overlay_open`
- `overlay_close`
- `overlay_set_bounds`
- `overlay_set_mode`
- `shortcuts_register`
- `shortcuts_unregister`
- `window_focus_main`
- `window_toggle_overlay`

Phase 2 command surface:

- `capture_start_native`
- `capture_stop_native`
- `capture_list_devices`
- `capture_system_audio_supported`

Phase 3 command surface:

- `sidecar_start_local_stack`
- `sidecar_stop_local_stack`
- `sidecar_health`

## 7.4 Tauri Events

Use Tauri events for coarse runtime signals:

- `runtime://shortcut`
- `runtime://overlay-closed`
- `runtime://sidecar-health`
- `capture://level`
- `capture://state`

Do not use Tauri events as the primary transcript transport.

Realtime transcript data should continue to come from the gateway stream.

## 7.5 Permissions And Capabilities

Tauri 2 should use strict permissions from day 1.

We should define:

- `core:default`
- only the plugin permissions actually required
- custom app permissions for each command group

Capability files should be split by surface:

- `main-window.json`
- `overlay-window.json`
- `sidecar.json`
- `capture.json`

Overlay windows should receive a narrower capability set than the main app.

## 8. Audio Architecture

Audio is the highest-risk area.

We should treat it as a staged migration.

## 8.1 Phase 1 Audio Strategy

Keep current browser-side microphone capture inside the Tauri webview:

- MediaDevices
- AudioContext
- AudioWorklet
- current PCM chunk pipeline

Why:

- fastest migration path
- preserves current working behavior
- minimizes simultaneous UI + runtime risk

## 8.2 Phase 2 Audio Strategy

Introduce a custom Tauri plugin for Windows-native capture where required.

Required targets:

- microphone enumeration
- system audio / loopback detection
- permission / capability normalization
- lower-latency native feed for future optimization

Suggested plugin name:

- `tauri-plugin-tts-capture`

Plugin responsibilities:

- expose supported devices
- expose capture capability matrix
- start/stop native capture
- emit PCM chunks or frame callbacks

## 8.3 Phase 3 Audio Strategy

Unify capture runtime behind a `CaptureRuntime` interface:

- `webCaptureRuntime`
- `tauriNativeCaptureRuntime`

Selection policy:

- microphone-only quick path -> web capture allowed
- system audio or desktop-only advanced mode -> native capture required

## 8.4 Original Audio Persistence

Original audio persistence should not depend on the UI layer.

Move it behind a dedicated service:

- `OriginalAudioArchiveService`

Inputs:

- raw PCM or uploaded file bytes
- mime type
- sequence
- session id

Outputs:

- persisted source audio clip records

## 9. Service Connectivity Model

Use two runtime modes.

## 9.1 Mode A: External Services

Used in development and early rollout.

Desktop app connects to:

- external `transcript-api`
- external `session-gateway`
- external `ai-worker`

Benefits:

- fastest migration
- least packaging complexity
- keeps existing scripts useful

## 9.2 Mode B: Local Sidecar Stack

Used only after the React + Tauri shell is stable.

Desktop app can optionally start local service sidecars.

This is only worth doing if the product needs:

- local-first operation
- simplified installation
- bundled single-desktop experience

Important decision:

- do not block the React + Tauri migration on sidecar packaging

## 10. Desktop UX Surface Design

## 10.1 Main Window

Main window contains:

- folder view
- session queue
- live workspace
- replay workspace
- summary and export rail

## 10.2 Overlay Window

Overlay becomes a dedicated Tauri window:

- transparent or semi-transparent
- always on top
- independent capability file
- same React app with overlay route

## 10.3 System Tray

Tray menu should support:

- open app
- toggle overlay
- start/stop capture
- quit

## 10.4 Global Shortcuts

Suggested shortcuts:

- toggle overlay
- start/stop recording
- quick mute / pause

## 11. Mapping Current Code To New Modules

Current sources:

- [shell.js](../apps/desktop/src/shell.js)
- [shell.html](../apps/desktop/src/shell.html)
- [overlay.js](../apps/desktop/src/overlay.js)
- [preview-channel.js](../apps/desktop/src/preview-channel.js)

Target migration map:

### `shell.js`

Split into:

- `features/sessions`
- `features/folders`
- `features/live`
- `features/replay`
- `features/audio`
- `lib/runtime`
- `lib/api`

### `shell.html`

Replace with:

- `App.tsx`
- route layouts
- component tree

### `overlay.js`

Replace with:

- shared overlay route inside React app
- Tauri window management in Rust/bridge layer

### `preview-channel.js`

Replace with:

- app store
- route state
- Tauri event bridge only where needed

## 12. Phased Migration Plan

## Phase 0: Freeze And Prepare

Duration:

- 2 to 3 days

Deliverables:

- no new major UI features added to raw shell
- define migration branch strategy
- add lint, format, TS config, and test foundations

Tasks:

- add TypeScript config for frontend packages
- define package boundaries
- add coding conventions for React/Tauri surface

## Phase 1: Scaffold React + Vite Inside `apps/desktop`

Duration:

- 3 to 5 days

Deliverables:

- React app boots in browser
- current desktop preview server can host built assets or dev server proxy
- i18n and Tailwind baseline working

Tasks:

- initialize Vite React TS app
- move static assets
- introduce router
- introduce app providers
- wire current API URLs into config

Acceptance:

- blank app boots
- language switch works
- current services can be reached

## Phase 2: Build Shared Desktop Domain Layer

Duration:

- 4 to 6 days

Deliverables:

- `packages/domain`
- `packages/api-client`
- typed replay/session clients

Tasks:

- extract session types and helpers
- build fetch/SSE clients
- add runtime validation
- create adapters for replay shaping and live transcript merge logic

Acceptance:

- no feature module fetches raw endpoints directly
- replay payload can be parsed and rendered from typed clients

## Phase 3: Port Feature Modules

Duration:

- 2 to 3 weeks

Order:

1. session list
2. folder strip and queue
3. preview drawer
4. replay navigator
5. live top bar
6. audio panel
7. summary rail
8. overlay route

Deliverables:

- React versions of the current core surfaces
- parity with existing workflow

Acceptance:

- user can create/open/replay sessions
- folder view works
- audio clips render and play
- overlay renders from shared state

## Phase 4: Wrap The React App In Tauri 2

Duration:

- 4 to 6 days

Deliverables:

- `src-tauri`
- `tauri.conf.json`
- capability files
- working `tauri dev`

Tasks:

- initialize Tauri 2 against the Vite app
- configure dev server URL
- configure build output
- verify Windows prerequisites in dev onboarding

Acceptance:

- app opens in Tauri window
- React shell works unchanged
- main window build and dev work reliably

## Phase 5: Introduce Desktop Runtime Features

Duration:

- 1 to 2 weeks

Deliverables:

- tray
- shortcuts
- dedicated overlay window
- local settings

Tasks:

- add runtime bridge package
- implement window commands
- implement overlay lifecycle
- implement shortcut registration

Acceptance:

- overlay is a real Tauri window
- tray actions work
- shortcut flow is stable on Windows

## Phase 6: Native Audio Spike

Duration:

- 1 to 2 weeks

Deliverables:

- capture capability matrix
- proof of native microphone and/or system loopback viability

Tasks:

- create custom Tauri plugin spike
- validate Windows loopback/system audio feasibility
- define fallback between web and native capture

Acceptance:

- clear go/no-go on native capture path
- documented interface for `CaptureRuntime`

## Phase 7: Packaging And Distribution

Duration:

- 4 to 7 days

Deliverables:

- signed desktop bundles
- installer strategy
- update strategy

Tasks:

- configure Windows bundle outputs
- set environment injection rules
- define release channel strategy

Acceptance:

- clean build on CI
- internal install works on a clean Windows machine

## 13. State Model Design

Recommended split:

### React Query

- `useSessionsQuery`
- `useReplayQuery`
- `useSummaryQuery`

### Zustand Stores

- `useShellUiStore`
- `useLiveStreamStore`
- `useCaptureStore`
- `useOverlayStore`
- `useSettingsStore`

### Derived Selectors

Keep computed logic outside components:

- ordered segments
- preferred translation
- latency badge state
- session chips
- title suggestion

## 14. Tauri Bridge Design

Define a shared runtime interface in TS:

```ts
export interface DesktopRuntime {
  platform(): Promise<"web" | "tauri">;
  openOverlay(payload?: { sessionId?: string }): Promise<void>;
  closeOverlay(): Promise<void>;
  registerShortcuts(): Promise<void>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
}
```

Provide two implementations:

- `browserDesktopRuntime`
- `tauriDesktopRuntime`

This allows:

- browser preview during migration
- Tauri desktop packaging later
- easier tests

## 15. Testing Strategy

## 15.1 Keep Existing Smoke Tests

Do not throw away current Node smoke coverage.

Current smoke tests continue guarding:

- provider selection
- text/audio ingest
- desktop preview availability

## 15.2 Add Frontend Unit Tests

Use:

- `Vitest`
- `React Testing Library`

Cover:

- replay selectors
- title suggestion logic
- session chips
- latency badge formatting
- drawer state

## 15.3 Add Desktop E2E

Use:

- browser-level Playwright for React app
- Tauri-level smoke once runtime is stable

Cover:

- open session
- preview drawer
- replay search jump
- overlay open
- audio clip playback rendering

## 16. CI / Dev Workflow

Recommended scripts:

- `dev:desktop:web`
- `dev:desktop:tauri`
- `build:desktop:web`
- `build:desktop:tauri`
- `test:ui`
- `test:e2e:desktop`

Recommended dev sequence:

1. start services
2. run Vite desktop app in browser
3. run Tauri wrapper only after the browser app is stable

## 17. Risk Register

## Risk 1: Native audio on Windows is harder than expected

Mitigation:

- keep microphone path in webview first
- isolate native capture into a plugin spike

## Risk 2: Tauri runtime constraints break overlay expectations

Mitigation:

- validate overlay behavior in phase 5 before fully deprecating browser preview

## Risk 3: Node services are awkward to package as sidecars

Mitigation:

- do not make sidecar packaging part of the first migration milestone

## Risk 4: UI migration stalls because everything moves at once

Mitigation:

- migrate feature-by-feature
- keep parity checkpoints
- do not rewrite service protocols

## 18. iOS Readiness Strategy

This migration is desktop-first.

But it should preserve iOS optionality by:

- keeping domain logic in shared TS packages
- isolating desktop runtime APIs
- avoiding Tauri-only assumptions in feature logic

Later iOS options:

- `Tauri mobile` if we want stronger shell reuse
- `React Native / Expo` if we want a more mobile-native product UX

This plan does not force that choice yet.

## 19. Definition Of Done

The migration is considered successful when:

1. The raw desktop shell is no longer the primary app surface.
2. Core desktop workflow runs in `React + Vite`.
3. Tauri 2 wraps the desktop shell successfully.
4. Overlay, tray, and shortcuts work in the desktop runtime.
5. Current service chain remains compatible.
6. The codebase has clear frontend package boundaries.
7. Native audio risk is either solved or isolated behind a validated fallback.

## 20. Official References

- React installation: [react.dev/learn/installation](https://react.dev/learn/installation)
- Vite guide: [vite.dev/guide](https://vite.dev/guide/)
- Tauri 2 overview: [v2.tauri.app](https://v2.tauri.app/)
- Tauri prerequisites: [v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/)
- Tauri create project: [v2.tauri.app/start/create-project](https://v2.tauri.app/start/create-project/)
- Tauri sidecars: [v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/)
- Tauri permissions: [v2.tauri.app/security/permissions](https://v2.tauri.app/security/permissions/)
- Tauri capabilities: [v2.tauri.app/security/capabilities](https://v2.tauri.app/security/capabilities/)
- Electron security guide: [electronjs.org/docs/latest/tutorial/security](https://www.electronjs.org/docs/latest/tutorial/security)

# Frontend And Runtime ADR v1

- Status: Draft
- Updated: 2026-03-22
- Owner: Codex / Frontend + Tech Lead

## 1. Background

The repository plan never intended the long-term product to stay on `Node + raw HTML`.

Existing planning documents already point to a framework-based direction:

- [README](C:/Users/westwell/projects/TTS/README.md) describes `apps/desktop` as `Electron + React`.
- [architecture-v1](C:/Users/westwell/projects/TTS/docs/architecture-v1.md) lists:
  - desktop: `Electron + React + Vite`
  - web: `Next.js` or `React + Vite`
- [iteration-3-adr](C:/Users/westwell/projects/TTS/docs/iteration-3-adr.md) explicitly downgraded the desktop app to a `shell preview` first, in order to validate the session and audio pipeline before committing to Electron.
- [apps/desktop/README](C:/Users/westwell/projects/TTS/apps/desktop/README.md) says the current desktop shell preview is not Electron and not the final desktop app.

That tradeoff was reasonable early on.

It is less reasonable now:

- [shell.js](C:/Users/westwell/projects/TTS/apps/desktop/src/shell.js) is already large enough to be a real app surface.
- [shell.html](C:/Users/westwell/projects/TTS/apps/desktop/src/shell.html) carries a large amount of layout and interaction logic.
- The product now has cross-view state, replay navigation, preview drawers, i18n, audio playback, and live capture state machines.

The UI complexity has crossed the point where hand-written DOM state is still the cheapest option.

## 2. Clarification: React Or Vite?

This is not an either/or choice.

- `React` is the UI framework and component/state model.
- `Vite` is the dev server and build tool.

Decision:

- Frontend stack should be `React + TypeScript + Vite`.

## 3. Decision

### 3.1 UI Stack

Choose:

- `React 19 + TypeScript + Vite`

Why:

- React solves the current pain directly:
  - component boundaries
  - local state isolation
  - predictable re-rendering
  - easier replay/preview/live view composition
- Vite is the simplest modern fit for this repo:
  - fast dev server
  - low ceremony
  - works well for desktop shell preview and web admin/viewer
  - aligns with the current no-SSR requirement
- TypeScript matches the existing monorepo direction and shared package model.

### 3.2 iOS Direction

Choose:

- `Expo / React Native`

Why:

- It keeps the team in the React mental model.
- It allows reuse of:
  - shared types
  - API contracts
  - transcript shaping logic
  - summary / replay business rules
- It avoids forcing desktop UI constraints onto mobile UI.

Important note:

- We should aim to share domain logic, not force 1:1 shared UI across desktop and iOS.

### 3.3 Desktop Runtime Direction

Primary recommendation:

- Rebuild the shell UI in `React + Vite` first.
- Do not bind the runtime decision to the first refactor commit.
- After the React shell is stable, prefer a short runtime spike:
  - first candidate: `Tauri 2`
  - fallback candidate: `Electron`

Reason:

- The current highest-confidence next move is the UI stack migration.
- The runtime choice is important, but it depends on whether the product needs deep native desktop features beyond what a web shell preview can simulate.

## 4. Re-evaluation Of Desktop Runtimes

### Option A: Electron

Strengths:

- Best-known desktop JS runtime.
- Mature desktop capability surface.
- Strong ecosystem for:
  - tray
  - global shortcuts
  - multi-window
  - preload / IPC
  - packaging and auto-update
- Safer choice when the product is desktop-capability-heavy.

Weaknesses:

- Larger binary and memory footprint.
- More security discipline required.
- Easy to accumulate main/preload/renderer complexity if boundaries are weak.

Best fit when:

- Windows capture, overlay windows, hotkeys, tray, and native integration are top priority.

Official references:

- [Electron docs](https://www.electronjs.org/docs/)
- [Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)

### Option B: Tauri 2

Strengths:

- Smaller runtime footprint than Electron.
- Frontend-independent.
- Better "native shell + web UI" aesthetics in many teams' hands.
- Tauri 2 expands beyond desktop into mobile support, which makes the ecosystem direction stronger than older Tauri-era assumptions.

Weaknesses:

- Requires Rust on the desktop runtime side.
- The plugin/native-bridge path is cleaner, but less forgiving than Electron when requirements get weird.
- For a product centered on audio capture and overlay behavior, the native-integration spike matters more than benchmarks on paper.

Best fit when:

- We want a more elegant desktop runtime than Electron and are willing to validate native integration explicitly.

Official reference:

- [Tauri 2 docs](https://v2.tauri.app/start/)

### Option C: Flutter

Strengths:

- Most coherent "single UI codebase" story across desktop and iOS.
- Strong desktop + mobile ambition.
- Good rendering consistency.

Weaknesses:

- Would abandon the current TS/web investment at the UI layer.
- Harder to reuse current browser preview work.
- Larger strategic rewrite than needed.

Best fit when:

- The business prioritizes a single shared UI layer over continuity with the current web/Node stack.

Official reference:

- [Flutter install docs](https://docs.flutter.dev/install)

### Option D: Wails

Strengths:

- Cleaner and lighter than Electron for some desktop apps.
- Go can be attractive for desktop-native teams.

Weaknesses:

- Introduces Go into a repo currently centered on Node/TypeScript.
- Poor alignment with the stated iOS future.
- Lower strategic fit than Tauri for this product.

Best fit when:

- The team already wants Go on the client/runtime side.

Official reference:

- [Wails docs](https://wails.io/docs/gettingstarted/installation/)

## 5. Recommendation Ranking

For this project, today:

1. `React + TypeScript + Vite` as the UI stack.
2. `Expo / React Native` as the iOS direction.
3. `Tauri 2` as the most elegant Electron alternative worth validating.
4. `Electron` as the safest fallback if the desktop-native spike reveals hard blockers in Tauri.
5. `Flutter` only if we deliberately decide to trade away the current TS/web direction for maximal UI code sharing.
6. `Wails` is not recommended for this repo.

## 6. What "Most Powerful Brain" Recommends Now

If we optimize for product reality instead of aesthetic purity:

- UI framework decision should be made now: `React + Vite + TypeScript`.
- Runtime should be treated as a second-stage choice.
- If forced to pick a desktop runtime right now:
  - prefer `Tauri 2` for elegance
  - keep `Electron` as the operationally safer fallback

This is the key nuance:

- "Most elegant alternative to Electron" is `Tauri 2`.
- "Safest guaranteed desktop delivery path" is still often `Electron`.

For this product, with future requirements including:

- microphone capture
- possible system audio capture
- floating overlay windows
- tray / shortcut behavior
- desktop-first live workflow

the runtime should be decided by a spike, not by aesthetics alone.

## 7. Concrete Next Steps

### Phase 0: Freeze The Raw Shell

- Stop expanding the current raw DOM shell except for blockers and bug fixes.
- Keep services unchanged.

### Phase 1: Introduce React UI Without Committing To Desktop Runtime

- Add `React + TypeScript + Vite` to `apps/desktop`.
- Keep the current `shell-server.mjs` only as the static file host if needed during migration.
- Port these areas first:
  - session list
  - preview drawer
  - live top bar
  - replay navigator
  - audio panel

### Phase 2: Extract Shared Frontend State

- Create shared frontend modules for:
  - session replay model
  - live transcript state
  - audio clip model
  - i18n

### Phase 3: Run A Desktop Runtime Spike

Validate the same minimal React shell in:

- `Tauri 2`
- `Electron`

The spike is only considered complete if both candidates are tested against:

1. overlay / always-on-top window behavior
2. tray and global shortcuts
3. microphone capture and file upload flow
4. Windows-specific audio integration risk
5. build and packaging ergonomics

### Phase 4: Start iOS Separately

- Build the iOS client in `Expo / React Native`.
- Reuse shared packages for:
  - types
  - network clients
  - transcript transformation
  - summary / replay business rules

## 8. Final Call

Final call for the project now:

- Use `React + TypeScript + Vite`.
- Treat `React` and `Vite` as complementary, not competing choices.
- For desktop runtime, investigate `Tauri 2` first.
- Keep `Electron` as a serious fallback, not a rejected option.
- For iOS, prefer `Expo / React Native`.

## 9. Source References

- [React installation](https://react.dev/learn/installation)
- [Vite getting started](https://vite.dev/guide/)
- [Electron docs](https://www.electronjs.org/docs/)
- [Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)
- [Tauri 2 docs](https://v2.tauri.app/start/)
- [Expo environment setup](https://docs.expo.dev/get-started/set-up-your-environment/)
- [Flutter install docs](https://docs.flutter.dev/install)
- [Wails install docs](https://wails.io/docs/gettingstarted/installation/)

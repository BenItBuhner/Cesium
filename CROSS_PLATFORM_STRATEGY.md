# Cesium: Cross-Platform Strategy Document

## Executive Summary

This document outlines a strategy for porting Cesium from a web-only Next.js application to a cross-platform architecture targeting web, iOS, Android, and future desktop platforms — while maximizing code reuse and preserving the existing investment.

**Current stack:** Next.js 16, React 19, Tailwind CSS 4, Hono server, Drizzle ORM, WebSocket-based agent communication.

**Recommended approach:** Expo Router + Solito monorepo, with Tamagui for universal UI and NativeWind for Tailwind-compatible styling. This yields ~70-80% code reuse across platforms for business logic, with platform-specific UI shells.

---

## 1. Code Sharing Between React Web and React Native

### 1.1 Framework Comparison

| Approach | Strategy | Code Reuse | Web SSR | Maturity | Fit for Cesium |
|---|---|---|---|---|---|
| **react-native-web** | RN components render on web via RNW | 60-70% | Limited/complex | Production (Twitter, Flipkart) | Low — requires rewriting web from scratch |
| **Solito** | Unified Next.js + RN navigation layer | 70-80% | Full (Next.js) | Production (BeatGig) | **High** — preserves Next.js, adds native |
| **Tamagui** | Universal styled components (replaces RNW) | 75-85% | Full (compiler-optimized) | Production | **High** — drop-in for both platforms |
| **NativeWind** | Tailwind CSS classes for RN | 70-80% style reuse | Via Expo Router/Next.js | Production (v5 stable) | **High** — preserves Tailwind investment |
| **Expo Router** | File-based routing for all platforms | 70-80% | Full | Production | **High** — replaces Next.js routing on native |

### 1.2 Recommended: Layered Approach

**Do not pick one — combine them strategically:**

```
┌──────────────────────────────────────────────────┐
│              Platform Shells                       │
│  Next.js (web)  │  Expo Router (iOS/Android)      │
├──────────────────────────────────────────────────┤
│           Solito (unified navigation)              │
├──────────────────────────────────────────────────┤
│     Tamagui / NativeWind (universal styling)       │
├──────────────────────────────────────────────────┤
│        Shared UI Components (Tamagui styled)       │
├──────────────────────────────────────────────────┤
│     Business Logic / State / API Layer             │
│     (Zustand + tRPC + shared TypeScript)           │
└──────────────────────────────────────────────────┘
```

### 1.3 react-native-web

- **What it does:** Aliases `react-native` imports to web-compatible DOM components. `View` → `div`, `Text` → `span`, etc.
- **Strengths:** Production-proven (Twitter/X uses it). Full React Native API compatibility on web.
- **Weaknesses:** You write RN-style code for web too — loses CSS flexibility, SSR is tricky, bundle size larger than needed.
- **Verdict for Cesium:** Don't use as the primary approach. We already have a web app with Tailwind. Rewriting the web UI into RN components would be a large regression. Use it indirectly via Tamagui (which can replace RNW's role more efficiently at ~28KB vs RNW's ~80KB).

### 1.4 Solito

- **What it does:** Unifies Next.js router and React Navigation into a single `useRouter()` / `<Link>` API. Share navigation code between Next.js web and Expo native.
- **Strengths:** Preserves Next.js for web (SSR, ISR, SSG). Minimal API surface. Works with Expo Router. Battle-tested at BeatGig.
- **Weaknesses:** Requires monorepo setup. Some navigation patterns need adaptation. Community-maintained (one primary author).
- **How to use:** Install `solito` in the shared UI package. Replace `next/link` and `next/router` usage with Solito's `<Link>` and `useRouter()`. On web, these delegate to Next.js; on native, to React Navigation / Expo Router.
- **Migration path for Cesium:** Gradual — start by wrapping existing Next.js navigation calls in Solito's API, then add the native app shell.

### 1.5 Tamagui

- **What it does:** Universal `styled()` API and component library that works identically on web and native. Includes an optimizing compiler that hoists/flattens styles at build time for near-zero runtime cost.
- **Strengths:** Best-in-class performance via compiler. Replaces both RNW and CSS-in-JS. Typed design tokens. SSR-friendly. Works with Next.js and Expo.
- **Weaknesses:** Learning curve for the token/theme system. Some community libraries don't integrate well. Requires build plugin configuration.
- **How to use:** Create a `@cesium/ui` package with Tamagui config (tokens, themes, fonts). Build universal components there. Both web and native apps consume this package.
- **Key for Cesium:** Since we use Tailwind, use Tamagui for structural/primitive components (View, Text, Stack, etc.) and NativeWind for Tailwind-style utility classes. They compose well together.

### 1.6 NativeWind (v5)

- **What it does:** Maps Tailwind CSS `className` values to React Native StyleSheet objects. Write `className="flex-1 px-4 bg-blue-500"` and it works on both web and native.
- **Strengths:** Preserves existing Tailwind knowledge and classes. Platform-specific prefixes (`ios:pt-8`, `android:pt-4`). Dark mode, P3 colors, CSS variables. v5 is stable and performant.
- **Weaknesses:** Not all Tailwind utilities map to RN (no `grid`, limited `position:fixed`, etc.). Requires Babel/SWC plugin. Some edge cases with dynamic classes.
- **How to use:** Configure NativeWind in the Expo app. Existing Tailwind classes from the web app can be reused in native components with minimal adaptation. Replace web-only CSS (`grid`, `position:sticky`) with RN equivalents (`FlatList`, `ScrollView` sticky headers).
- **Key for Cesium:** This is the highest-value adoption path. Our entire web UI uses Tailwind. NativeWind lets us reuse ~70% of those class names directly on native.

### 1.7 Realistic Code Sharing Estimates

| Layer | Reuse Estimate | Notes |
|---|---|---|
| Business logic (agent config, chat modes, conversation events) | **95-100%** | Pure TS, no platform deps |
| State management (Zustand stores) | **95-100%** | Zustand is platform-agnostic |
| API layer (tRPC client, types) | **95-100%** | HTTP is universal |
| Types/interfaces | **100%** | Shared TypeScript package |
| Hooks (non-DOM) | **80-90%** | DOM-specific hooks need adaptation |
| Hooks (DOM-dependent) | **20-40%** | Viewport, keyboard, click-outside need RN equivalents |
| UI components (layout/structural) | **60-80%** | With Tamagui + NativeWind, most layout is portable |
| UI components (complex/web-specific) | **10-30%** | Monaco editor, xterm.js, resizable panels need native replacements |
| Navigation | **70-90%** | With Solito, route definitions are shared |
| Styling | **60-70%** | NativeWind covers most Tailwind; some CSS features need RN alternatives |

**Overall realistic code sharing: 60-70%** for the full application, **80-90%** for non-UI code.

---

## 2. Monorepo Setup

### 2.1 Turborepo vs Nx

| Feature | Turborepo | Nx |
|---|---|---|
| Setup complexity | Low — 5 min to add | Medium — more opinionated |
| Task orchestration | Excellent (parallel, cached) | Excellent (parallel, cached, distributed) |
| Caching | Local + Remote (Vercel) | Local + Nx Cloud (distributed) |
| Project graph | Basic | Advanced (dependency graph, affected commands) |
| Module boundary enforcement | No | Yes (eslint rules) |
| Code generation | No | Yes (generators, scaffolding) |
| Learning curve | Low | Medium-high |
| Best for | Small-to-medium monorepos | Large, complex monorepos |

**Recommendation: Turborepo** for initial setup. It's simpler, faster to adopt, and pairs naturally with Next.js (same ecosystem/Vercel). Migrate to Nx later if boundary enforcement and code generation become critical.

### 2.2 Recommended Package Structure

```
cesium/
├── apps/
│   ├── web/                    # Next.js app (current Cesium)
│   ├── native/                 # Expo Router app (iOS + Android)
│   └── desktop/                # Future: react-native-macos or Electron/Bun
├── packages/
│   ├── ui/                     # @cesium/ui - Shared Tamagui + NativeWind components
│   ├── core/                   # @cesium/core - Business logic, state, types
│   ├── api-client/             # @cesium/api-client - tRPC client, HTTP utils
│   ├── agent/                  # @cesium/agent - Agent logic, conversation engine
│   ├── server/                 # @cesium/server - Hono API server (current server/)
│   └── tsconfig/               # @cesium/tsconfig - Shared TypeScript configs
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

### 2.3 Package Responsibilities

#### `@cesium/core`
- All current `src/lib/` files that are platform-agnostic
- Agent types, config options, conversation events, chat modes
- State stores (Zustand) — workspace session, preferences, settings
- Utility functions (path-utils, queued-prompt-utils, etc.)
- **Extraction from current codebase:** Move these files with minimal changes:
  - `agent-types.ts` → `@cesium/core`
  - `agent-config-option-utils.ts` → `@cesium/core`
  - `agent-conversation-events.ts` → `@cesium/core`
  - `agent-chat.ts` → `@cesium/core`
  - `agent-subagent-routing.ts` → `@cesium/core`
  - `chat-modes.ts` → `@cesium/core`
  - `preferences.ts` → `@cesium/core`
  - `global-settings.ts` → `@cesium/core`
  - `types.ts` → `@cesium/core`
  - `workbench-view.ts` → `@cesium/core`

#### `@cesium/api-client`
- tRPC client setup
- Shared TypeScript types and interfaces
- HTTP client abstraction (fetch wrapper)
- WebSocket client (adapted from current `ws-client.ts`)
- Server connection logic (from `server-connections.ts`, `server-connections-provider-shared.ts`)
- Auth client (from `auth-client.ts`)

#### `@cesium/agent`
- Agent rail logic (`agent-rail.ts`, `agent-rail-pins.ts`, `agent-rail-patch.ts`)
- Agent mock data
- Agent backend icons (needs platform abstraction for icon rendering)
- Sub-agent routing

#### `@cesium/ui`
- Tamagui configuration (tokens, themes, fonts)
- Shared primitive components (Button, Card, Input, etc.)
- Layout components that work on both platforms
- NativeWind + Tamagui styled components
- **Does NOT include:** Monaco editor, xterm.js, resizable panels (these are web-only and stay in `apps/web`)

#### `@cesium/server`
- Current `server/` directory moves here as-is
- Hono routes, Drizzle ORM, WebSocket server, storage
- No changes needed — server is already platform-independent

### 2.4 Shared Agent Logic Strategy

The agent system is Cesium's core value. Here's how to share it:

```
@cesium/agent/
├── core/
│   ├── rail.ts              # Agent rail orchestration (shared)
│   ├── rail-pins.ts         # Pin management (shared)
│   ├── conversation.ts      # Conversation flow (shared)
│   ├── subagent-routing.ts  # Sub-agent dispatch (shared)
│   └── types.ts             # Agent types (shared)
├── renderers/
│   ├── web.ts               # Web-specific rendering (Monaco, xterm)
│   └── native.ts            # Native rendering (code display, terminal)
└── index.ts
```

Agent *logic* (routing, conversation flow, configuration) is 100% shared. Agent *rendering* (how code diffs appear, how terminal output is shown) uses platform-specific components behind a shared interface.

---

## 3. Future Platform Expansion

### 3.1 React Native for iOS

iOS is the natural first native target after web. Key considerations:

- **Expo handles most of this.** `npx create-expo-app` with iOS target. Expo SDK provides camera, filesystem, sensors, etc.
- **Native modules:** Any native iOS code needed should be written as Expo Modules (Swift/Kotlin) or config plugins.
- **App Store requirements:** Apple Developer account, certificates, provisioning profiles. EAS Submit handles this.
- **iOS-specific UI patterns:** Tab bar at bottom (not sidebar), swipe gestures, haptic feedback, SF Symbols for icons.
- **Performance:** Hermes engine (default in Expo) is optimized for mobile. Watch memory usage on older devices.
- **Agent-specific:** No Monaco editor on iOS — need native code viewer. No xterm — need native terminal emulator or simplified output view.

### 3.2 React Native for macOS

- **Status:** The original `react-native-macos` by @ptmt is **deprecated**. Microsoft now maintains it as part of `react-native-windows`.
- **Current path:** Use `react-native-macos` from Microsoft's react-native-windows repo (it's a separate extension).
- **Maturity:** Less mature than RNW for Windows. Apple Catalyst apps have limitations.
- **Alternative:** Use Mac Catalyst (ship iOS app on macOS) via Xcode — simpler but limited to iOS UI paradigms.
- **Recommendation:** Don't target macOS natively yet. If desktop is needed, use the web app or a Tauri/Bun shell (see below).

### 3.3 React Native for Windows

- **Status:** Actively maintained by Microsoft. v0.82 aligned with RN 0.82. Fabric architecture (new arch) is now required.
- **Components:** Supports core RN components + Windows-specific ones (Flyout, Popup, Pivot, etc.).
- **Best for:** Enterprise Windows apps, Xbox apps, Surface tablet apps.
- **Setup:** `npx react-native-windows-init` after standard RN project setup.
- **Recommendation:** Consider if enterprise Windows deployment is needed. Low priority for Cesium unless specifically requested.

### 3.4 Electron Alternative: Bun Runtime

Current desktop options for Cesium:

| Approach | Bundle Size | Startup | Memory | Native Feel | Complexity |
|---|---|---|---|---|---|
| **Electron** | ~150MB+ | Slow | High (Chromium per instance) | Low | Low |
| **Tauri** | ~5-10MB | Fast | Low (system webview) | Medium | Medium (Rust) |
| **Bun + system webview** | ~20-50MB | Fast | Low | Medium | High (DIY) |
| **RN macOS** | ~30-50MB | Medium | Medium | High | Medium |

**Recommendation for desktop:** **Tauri v2** is the best Electron alternative today — small bundle, system webview, Rust backend. If you want a JS-only backend, use **Bun** as the runtime with a system webview (via `webview_deno` or similar), but this is more experimental.

**For Cesium specifically:** The server already runs on Node/Hono. A Tauri wrapper that embeds the web app + runs the Hono server locally would be the cleanest desktop path. Bun could replace Node as the runtime for the server component.

### 3.5 Expo Multi-Platform Support

Expo now supports:

- **Web** — via `npx expo export:web` or Expo Router's web mode
- **iOS** — via EAS Build or local Xcode
- **Android** — via EAS Build or local Android Studio
- **Not yet official:** macOS, Windows (use react-native-windows separately)

**Key Expo features for multi-platform:**
- **Expo Router:** File-based routing that works on all platforms (web, iOS, Android)
- **Expo SDK:** Consistent APIs for camera, filesystem, sensors, etc.
- **EAS Update:** Over-the-air updates for JS changes without app store review
- **Continuous Native Generation (CNG):** Native projects generated from `app.json` — easier upgrades and maintenance
- **Module API:** Write native modules in Swift/Kotlin with JS interop

**Cesium migration path with Expo:**

1. **Phase 1:** Keep Next.js for web. Create Expo app for mobile. Share business logic via monorepo packages.
2. **Phase 2:** Evaluate Expo Router for web (replacing Next.js) if SSR isn't critical. This gives unified routing.
3. **Phase 3:** Consider `apps/desktop/` with Tauri wrapping the web build.

---

## 4. State Management Across Platforms

### 4.1 Zustand (Recommended)

```typescript
// packages/core/src/stores/workspace.ts
import { create } from 'zustand'

interface WorkspaceState {
  activeSession: string | null
  sessions: Record<string, WorkspaceSession>
  setActiveSession: (id: string) => void
  // ...
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSession: null,
  sessions: {},
  setActiveSession: (id) => set({ activeSession: id }),
}))
```

**Why Zustand:**
- Zero platform dependencies — works in React, React Native, any JS runtime
- ~1KB bundle size
- No provider needed (unlike Redux/Jotai context)
- Supports persistence via `zustand/middleware` (mmkv on native, localStorage on web)
- Supports subscriptions outside React (useful for server-side agent logic)
- Works with React 19 concurrent features

### 4.2 Jotai (Alternative)

**Why Jotai:**
- Atomic state model — compose state from atoms
- Great for derived state (e.g., computed agent status)
- Works everywhere Zustand does

**Why not Jotai as primary:**
- Requires Provider wrapping (`<JotaiProvider>`)
- More boilerplate for simple state
- Less straightforward for large state trees (Cesium has many interconnected stores)

**Hybrid approach:** Use Zustand as primary state management. Use Jotai atoms for derived/computed state where atomic composition is beneficial (e.g., agent status derived from multiple stores).

### 4.3 Sharing State Logic

```typescript
// packages/core/src/stores/platform.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Platform-agnostic storage adapter
const storageAdapter = {
  getItem: async (name: string) => {
    if (typeof window !== 'undefined') {
      // Web: localStorage
      const item = localStorage.getItem(name)
      return item ? JSON.parse(item) : null
    }
    // Native: MMKV or AsyncStorage
    const MMKV = require('react-native-mmkv')
    const item = MMKV.getString(name)
    return item ? JSON.parse(item) : null
  },
  setItem: async (name: string, value: any) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(name, JSON.stringify(value))
    } else {
      const MMKV = require('react-native-mmkv')
      MMKV.set(name, JSON.stringify(value))
    }
  },
  removeItem: async (name: string) => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(name)
    } else {
      const MMKV = require('react-native-mmkv')
      MMKV.delete(name)
    }
  },
}

export const usePersistedStore = create(
  persist(
    (set) => ({
      // state
    }),
    {
      name: 'cesium-store',
      storage: createJSONStorage(() => storageAdapter),
    }
  )
)
```

**Key principle:** Stores are defined in `@cesium/core` with platform-agnostic logic. Platform-specific adapters (storage, networking) are injected at app initialization.

---

## 5. API Layer Sharing

### 5.1 HTTP Client Code

```typescript
// packages/api-client/src/http.ts
// Platform-agnostic fetch wrapper — works on web, RN, and Node/Bun

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 
                 process.env.NEXT_PUBLIC_API_URL ?? 
                 'http://localhost:3001'

export async function apiFetch<T>(
  path: string, 
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}
```

**Key points:**
- Use standard `fetch` — available in all modern runtimes (browser, RN 0.73+, Node 18+, Bun)
- Don't use `axios` — it adds ~15KB and is unnecessary with modern fetch
- Environment variables use `EXPO_PUBLIC_` prefix for native, `NEXT_PUBLIC_` for Next.js — handle both

### 5.2 tRPC for Type-Safe APIs

```typescript
// packages/api-client/src/trpc.ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@cesium/server/src/router'

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: getBaseUrl() + '/trpc',
      fetch: platformFetch, // platform-aware fetch
    }),
  ],
})

// Usage (identical on web and native):
const conversations = await trpc.conversations.list.query({ limit: 20 })
const result = await trpc.agents.chat.mutate({ message, agentId })
```

**Why tRPC for Cesium:**
- End-to-end type safety — server router types flow to all clients
- No code generation step (unlike GraphQL)
- Works with Hono (adapter: `@trpc/server/adapters/hono`)
- Vanilla client works on any platform (RN, web, Node)
- Request batching for performance
- Can coexist with existing Hono REST routes during migration

**Migration path:**
1. Add tRPC to existing Hono server as a mounted route
2. Create tRPC router wrapping existing Hono endpoints
3. Build tRPC client in `@cesium/api-client`
4. Gradually migrate frontend from direct fetch to tRPC calls

### 5.3 Shared TypeScript Types

```typescript
// packages/core/src/types/index.ts

export interface AgentConfig {
  id: string
  name: string
  model: string
  systemPrompt: string
  tools: AgentTool[]
  railPins: RailPinConfig[]
}

export interface Conversation {
  id: string
  agentId: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: MessageMetadata
}

// These types are imported by:
// - apps/web (Next.js)
// - apps/native (Expo)
// - packages/server (Hono/tRPC)
// - packages/agent (agent logic)
```

**Structure:**
```
packages/core/src/types/
├── agent.ts        # Agent, AgentConfig, AgentTool
├── conversation.ts # Conversation, Message, ConversationEvent
├── workspace.ts    # Workspace, WorkspaceSession
├── chat.ts         # ChatMode, ChatSettings
├── settings.ts     # Preferences, GlobalSettings
├── api.ts          # API request/response types
└── index.ts        # Re-exports all
```

---

## 6. Build and Deployment

### 6.1 EAS Build (Expo Application Services)

```yaml
# eas.json
{
  "cli": { "version": ">= 13.2.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true },
      "android": { "buildType": "apk" },
      "env": { "APP_ENV": "development" }
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": { "APP_ENV": "staging" }
    },
    "production": {
      "autoIncrement": true,
      "env": { "APP_ENV": "production" }
    }
  },
  "submit": {
    "production": {
      "ios": { "appleId": "team@apple.com" },
      "android": { "serviceAccountKeyPath": "./google-play-key.json" }
    }
  }
}
```

**EAS Services for Cesium:**
- **EAS Build:** Cloud builds for iOS/Android — no Mac required for iOS builds
- **EAS Submit:** One-command store uploads (`eas submit --platform ios`)
- **EAS Update:** Push JS updates without app store review (critical for agent logic hotfixes)
- **EAS Hosting:** Deploy web app and API routes (alternative to Vercel for the Expo Router web build)

### 6.2 Fastlane for Automated Deployments

```ruby
# fastlane/Fastfile
default_platform(:ios)

platform :ios do
  desc "Build and deploy to TestFlight"
  lane :beta do
    build_app(workspace: "Cesium.xcworkspace", scheme: "Cesium")
    upload_to_testflight(skip_waiting_for_build_processing: true)
  end

  desc "Deploy to App Store"
  lane :release do
    build_app(workspace: "Cesium.xcworkspace", scheme: "Cesium")
    deliver
  end
end

platform :android do
  desc "Deploy to Google Play Beta"
  lane :beta do
    gradle(task: "assembleRelease")
    upload_to_play_store(track: "internal")
  end
end
```

**Recommendation:** Use **EAS Build + Submit** for simplicity. Use **Fastlane** only if you need:
- Local builds (not cloud)
- Custom signing workflows
- Integration with existing CI/CD (GitHub Actions with self-hosted runners)
- Screenshots automation (`snapshot` / `screengrab`)

### 6.3 Build Configuration Matrix

| Config | Web | iOS | Android | Desktop |
|---|---|---|---|---|
| **Dev** | `next dev` | `expo start --ios` | `expo start --android` | `tauri dev` |
| **Staging** | Vercel preview | EAS Build (preview) + TestFlight Internal | EAS Build (preview) + Play Console Internal | Tauri build (dev) |
| **Prod** | Vercel production | EAS Build (prod) + App Store | EAS Build (prod) + Play Store | Tauri build (release) + auto-update |
| **Hotfix** | Vercel instant deploy | **EAS Update** (no review) | **EAS Update** (no review) | Tauri update server |

### 6.4 Environment Variables

```
# Shared (in packages/core)
APP_ENV=development|staging|production

# Web-specific (prefixed NEXT_PUBLIC_)
NEXT_PUBLIC_API_URL=https://api.cesium.dev
NEXT_PUBLIC_WS_URL=wss://api.cesium.dev/ws

# Native-specific (prefixed EXPO_PUBLIC_)
EXPO_PUBLIC_API_URL=https://api.cesium.dev
EXPO_PUBLIC_WS_URL=wss://api.cesium.dev/ws

# Server-only (never exposed to client)
DATABASE_URL=postgres://...
REDIS_URL=redis://...
OPENAI_API_KEY=sk-...
```

---

## 7. Testing Across Platforms

### 7.1 Shared Test Suites

```typescript
// packages/core/src/__tests__/agent-rail.test.ts
// This test runs identically on any platform

import { describe, it, expect } from 'vitest'
import { createAgentRail } from '../agent-rail'

describe('AgentRail', () => {
  it('routes messages to correct sub-agent', () => {
    const rail = createAgentRail(config)
    const result = rail.route({ message: 'fix the bug', agentId: 'coder' })
    expect(result.subAgent).toBe('code-agent')
  })
})
```

**Strategy:** All tests in `packages/core`, `packages/api-client`, and `packages/agent` are platform-agnostic. They test pure business logic and run in Node/Vitest.

### 7.2 Platform-Specific Testing

| Platform | Unit Tests | Integration Tests | E2E Tests |
|---|---|---|---|
| **Web** | Vitest + jsdom | React Testing Library | Playwright |
| **iOS** | Vitest (shared) + native module mocks | React Native Testing Library | Detox / Maestro |
| **Android** | Vitest (shared) + native module mocks | React Native Testing Library | Detox / Maestro |
| **Server** | Vitest + test containers | Hono test client | HTTP E2E |

### 7.3 Recommended Test Structure

```
packages/core/
  src/__tests__/           # Shared unit tests (Vitest)
  src/**/*.test.ts         # Co-located tests

apps/web/
  src/__tests__/           # Web-specific component tests (RTL + jsdom)
  e2e/                     # Playwright E2E

apps/native/
  src/__tests__/           # RN component tests (RNTL)
  e2e/                     # Detox or Maestro E2E

packages/server/
  test/                    # Server integration tests (Hono client)
```

### 7.4 CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  shared-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo test --filter=@cesium/core --filter=@cesium/api-client --filter=@cesium/agent

  web-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm turbo test --filter=@cesium/web
      - run: pnpm turbo lint --filter=@cesium/web
      - run: pnpm turbo build --filter=@cesium/web

  server-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm turbo test --filter=@cesium/server

  native-build:
    runs-on: macos-latest  # Need macOS for iOS builds
    steps:
      - run: pnpm turbo build --filter=@cesium/native
      - uses: expo/eas-build@v1  # Optional: cloud build on CI
```

---

## 8. Recommended Architecture: Final

### Phase 1: Foundation (Weeks 1-3)

1. **Set up Turborepo monorepo** with pnpm workspaces
2. **Create `packages/core`** — extract platform-agnostic business logic from `src/lib/`
3. **Create `packages/api-client`** — extract HTTP/WS client code, add tRPC client
4. **Move `server/`** to `packages/server` (minimal changes)
5. **Wire up existing web app** (`apps/web`) to consume new packages
6. **Verify:** Web app works exactly as before, now using monorepo packages

### Phase 2: Native Shell (Weeks 4-7)

1. **Create `apps/native`** — Expo Router app with Solito
2. **Set up Tamagui + NativeWind** — configure design tokens matching current Tailwind theme
3. **Build `@cesium/ui`** — universal primitive components (Text, View, Button, Card, Input)
4. **Create native navigation** — mirror web app routes using Expo Router
5. **Implement core screens** — Chat, Agent list, Settings, Workspace
6. **Web-only components stay in `apps/web`:** Monaco editor, xterm.js, resizable panels, PWA features
7. **Create native equivalents for web-only components:** Code highlight viewer (SyntaxHighlighter), simplified terminal output, native navigation patterns

### Phase 3: State & API Unification (Weeks 8-10)

1. **Migrate state to Zustand** in `@cesium/core`
2. **Add tRPC** to server and client packages
3. **Share WebSocket client** with platform adapters
4. **Add EAS Update** for OTA JS updates
5. **Write shared test suites**

### Phase 4: Polish & Deploy (Weeks 11-14)

1. **EAS Build** configuration for iOS/Android
2. **App Store / Play Store** submission
3. **Performance optimization** — Hermes, bundle splitting, lazy loading
4. **E2E testing** — Maestro for native, Playwright for web
5. **CI/CD pipeline** — GitHub Actions + Turborepo cache

### Phase 5: Future Platforms (Post-Launch)

1. **Desktop:** Evaluate Tauri v2 wrapper for web build
2. **Windows:** Evaluate react-native-windows if enterprise demand exists
3. **macOS:** Monitor react-native-macos maturity; use Catalyst as interim

---

## 9. Risk Mitigation

| Risk | Mitigation |
|---|---|
| Web feature regression | Keep Next.js as web platform; don't force web into RN paradigms |
| Native app feels like wrapped website | Invest in platform-specific UX (iOS tab bars, Android material patterns) |
| Monorepo complexity slows development | Start with Turborepo (simple), only adopt Nx features as needed |
| Shared UI looks wrong on one platform | Use `.web.tsx` / `.native.tsx` file extensions for platform overrides |
| WebSocket behavior differs on mobile | Test reconnect logic on both platforms; use Expo's `AppState` for background/foreground |
| Agent rendering (Monaco, xterm) unavailable on native | Build native code viewer + terminal output components; accept reduced functionality initially |
| Third-party libraries don't support RN | Check reactnative.directory.com before adopting; prefer universal libraries |
| Turborepo caching breaks | Pin dependency versions; use `turbo.json` inputs correctly |

---

## 10. Key Decision Summary

| Decision | Recommendation | Rationale |
|---|---|---|
| Monorepo tool | **Turborepo** | Simpler, faster to adopt, pairs with Vercel/Next.js |
| UI framework | **Tamagui + NativeWind** | Tamagui for primitives, NativeWind for Tailwind compat |
| Navigation | **Solito + Expo Router** | Unified routing, preserves Next.js on web |
| State management | **Zustand** | Platform-agnostic, no provider, small bundle |
| API layer | **tRPC + Hono** | Type-safe, zero codegen, Hono adapter exists |
| Mobile build | **EAS Build + Submit** | Cloud builds, no Mac required, OTA updates |
| Desktop strategy | **Tauri v2** (future) | Best Electron alternative — small, fast, Rust backend |
| Testing | **Vitest + RNTL + Maestro** | Vitest for shared, RNTL for native components, Maestro for E2E |
| Package manager | **pnpm** | Strictest dependency resolution, fastest installs, workspace support |

---

*Generated for Cesium — a React/Next.js web application with Hono server, agent-based AI coding assistant, WebSocket communication, and Monaco/xterm editing interfaces.*

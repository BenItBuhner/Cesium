# Cesium vs T3 Code (2026-08-26) — product triage

Read-only. GitHub + this repo are source of truth. Linear is stale. Do not merge leftover drafts as-is.

Scored against T3's 2026-08-25 release: **exists / stub / missing / covered elsewhere**.

## Scorecard

| T3 highlight | Score | Why this is or is not a Cesium goal |
| --- | --- | --- |
| 1. In-app PR reviews (activity + agent + GitHub pane) | **covered elsewhere / stub** | Same window already has agent rail + chat + `PullRequestView` (`src/components/editor/PullRequestView.tsx`: overview / commits / files + GH description/comments). Not a GitHub clone: no merge, checks, reviewers, labels, timeline. Rail `#98` is the activity list. Cloning T3's triple-pane is a non-goal. |
| 2. `npx t3 triage` | **missing** | `cesium` CLI (`packages/cli`) is install/start/status/logs/connect/update only. `#211` was a one-off human triage, not a self-heal command. |
| 3. `npx t3 connect` (Mac remote pair) | **exists (different shape)** | `cesium install --web-url` + `cesium connect` + rendezvous + `#213` account-shared servers. Tunnels are localhost.run / Cloudflare, not Tailscale. Prints URL+creds; not a one-shot Mac pairing app. |
| 4. Long-thread render + data size | **exists** | Virtualize at 16 msgs (`MessageList.tsx`), `snapshot_head`, stream-render perf hook. Incremental polish, not a T3 chase. |
| 5. In-app terminal perf | **exists** | xterm + `/ws/terminal`; Bun.Terminal on POSIX. `#211` already touched terminals. Chase only on a measured jank report. |
| 6. Faster remote upgrades | **exists (rough)** | `cesium update` re-runs `install-cesium-server.sh` after stop (`scripts/cesium-server`). Reliability/rollback is the gap, not inventing update. |
| 7. Open remote project in VS Code via SSH | **missing / non-goal** | In-app SSH workspace wizard (`WorkspaceStudioModal.tsx`). No `code --remote`. VS Code compatibility runtime is already beta — keep people in Cesium. |
| 8. OpenVSX themes in-app | **exists (beta)** | Open VSX + VSIX + theme loader (`server/src/lib/extensions/theme-loader.ts`, Settings → VS Code extensions). JSON themes only; no `.tmTheme`. |
| 9. Codex / OpenCode / Claude project skills listed in-app | **exists on disk, stub in UI** | Discovery: `.agents`, `.cursor`, `.claude`, `.codex` (`workspace-skills.ts`) + `agent-skills/` mirror into prompts. **No `.opencode/skills`.** Settings `RulesSkillsSubagentsPanel.tsx` is breadcrumbs only. Slash placeholder says "Search skills" but `getSlashMenuSections` has no skills section. |
| 10. Auto-scroll | **exists** | `stickToBottom` in `MessageList.tsx` / `WorkedSessionCard.tsx` + scroll anchors. Fix bugs; do not rebuild. |
| 11. Compaction recommendations (Claude-style) | **stub** | Context usage ring/dock (`ContextBreakdownDock.tsx`). Voice compaction is live. Agent path is still heuristic `summarizeForCompression` in `cesium-history.ts`. **Draft `#88` did not land** (its body falsely says merged via `#98`; `#98` is the rail). |
| 12. Harness permission / MCP / Computer Use | **exists** | `PermissionRequestCard` + `AskQuestionCard` + rail "Needs approval". No named Computer Use surface. Codex-style approvals are already the product. |
| 13. Windows desktop polish | **just shipped** | `#214` one-click NSIS + icons (2026-08-25). Left: unsigned SmartScreen; `cesium` CLI is WSL-only (`packages/cli/bin/cesium.mjs`). |

T3's broader surface (multi-harness, web, Electron, iOS+Android, pairing) is already Cesium's bet: Cursor / Codex / Claude / OpenCode / Grok Build / Pi / Devin / Antigravity / built-in `cesium-agent`; web + Electron + Android + Wear + iOS project; pairing is rendezvous, not Tailscale.

## Pick these (smallest slices)

1. **In-app skill catalog (do this).** Wire `RulesSkillsSubagentsPanel` to `discoverWorkspaceSkills` + plugin mirrors. Add `.opencode/skills`. Optional: slash section matching the placeholder. Why now: T3 just marketed "reliable skill discovery"; Cesium already discovers and injects — users just cannot see them. Settings page today is an empty lie.

2. **Close the leftover-draft trap; ship `#217`.** `#65` Live Voice, `#88` compaction, `#120` share-sheet are dirty drafts. Voice orb + share intake are already on `main`. Close or rebase; **do not merge**. `#217` (landing Sign up / Sign in / Continue as guest) is the only leftover that matches post-`#212`/`#216` production.

Honorable mention, not this week: `cesium doctor` (health + logs + rendezvous) after `#212` production; in-place `cesium update` without full reinstall.

## Traps

- Linear is stale. Use GitHub + code.
- `#88` PR body is wrong: `#98` is the agent rail, not ledger compaction. `cesium-compaction.ts` / `ledger-v1` are **not on main**.
- `#65` / `#120` look unmerged; `VoiceOrb` / `MobileShareIntake` are already in the tree.
- GitHub repo blurb still says "open-source cloud agent" + typo "eabling". Product copy is local-first workbench (`README.md`, landing).
- Landing still primary-CTAs "Launch workbench" on `main`; `#217` fixes that. Landing "Voice input" is STT, not Live Voice. Landing "Mobile" = Android; iOS native + Wear exist. README still lists Gemini CLI; landing/providers are Antigravity.
- Settings search indexes "Rules, skills, and subagents" as a real page.

## Explicit non-goals

Wear OS, Live Voice, VS Code compatibility runtime, custom agent harness, Android live notifications (Bennett: already beta-integrated). Cloning T3's GitHub PR chrome. Tailscale pairing. Merging `#65`/`#88`/`#120`. Building `npx t3 triage` as a brand clone. One-click "Open in VS Code SSH" as a strategy. Another Windows installer pass unless SmartScreen signing is on the table.

---
name: conversation-digest
description: Compiles a digest of recent conversations: searches saved conversations across workspaces, reads transcripts, extracts highlights and decisions, and produces a compact summary document the user can quickly scan. Use when the user asks for a digest, recap, or summary of recent work or conversations.
---

# Conversation Digest

# Conversation Digest

## Purpose
Compile a compact digest of recent conversations: search across saved conversations, extract highlights and decisions, and produce a summary document the user can quickly scan.

## When to Use
- The user asks for a "digest," "summary," or "recap" of recent conversations or work.
- The user wants to catch up on what happened across workspaces or past sessions.
- A standup, weekly review, or handoff needs a synthesized view of recent activity.

## Steps

### 1. Discover recent conversations
- Call `list_conversations` (limit 15–25) to get the most recent conversations across all workspaces. Note each conversation's id, title, workspace, and last-update time.
- If the user names a topic, workspace, or keyword, also call `search_conversations` with that query to surface older but relevant threads.
- Optionally call `search_history` for context within the current conversation's own long history.

### 2. Read and extract
- For each conversation that looks relevant (based on title and recency), call `read_conversation` with `conversationId` and a bounded `limitTurns` (10–20) plus `maxChars` (8000–12000) to stay efficient.
- As you read, extract per-conversation:
  - **Highlights**: key outcomes, deliverables produced, problems solved.
  - **Decisions**: choices made, directions agreed upon, constraints established.
  - **Open items**: unfinished work, blockers, follow-ups mentioned.
  - **Artifacts**: files created, skills documented, triggers scheduled, memory saved.
- Skip conversations that are trivial, empty, or clearly unrelated to the user's work.

### 3. Synthesize
- Group findings thematically or chronologically (prefer thematic when spanning many conversations).
- Identify cross-conversation threads: recurring topics, evolving decisions, ongoing projects.
- Note any contradictions or stale information that may need correction.

### 4. Produce the digest
- Write the digest as a workspace document via `write_file` (e.g., `digests/YYYY-MM-DD-digest.md`) or as an artifact if the user prefers a richer format.
- Structure:
  - **Header**: date range covered, number of conversations reviewed.
  - **Highlights** (bullet list, one line each).
  - **Key Decisions** (bullet list).
  - **Open Items / Follow-ups** (bullet list, with owning conversation if known).
  - **Cross-cutting Themes** (short paragraph or bullets).
  - **Conversation Index** (table: title, workspace, last updated, one-line summary).
- Keep it compact: aim for one screen of scannable content, not a transcript dump.
- Offer to save durable facts/decisions to `memory` (scope `workspace` or `user`) if anything new and worth persisting was found.

## Caveats
- `read_conversation` returns most recent turns first; for long conversations, page with `limitTurns` and `maxChars` rather than reading everything.
- Respect privacy: do not include sensitive credentials or secrets that may appear in transcripts.
- If the user asks for a specific workspace, pass `workspaceId` to `list_conversations` to scope results.
- The digest is a summary, not a replacement for reading full transcripts when precision matters.

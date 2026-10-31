# TODOs

## Detect external changes of an open opencode session in `lru` mode

- **What:** before prompting a session that is still open in the connector, notice that the opencode session was continued elsewhere (TUI, another client) and reload it.
- **Why:** the R13 check (`#transcriptPath` in `src/acp/session-manager.ts`) only knows Claude transcripts, so it never fires for opencode. In `lru` mode an opencode session can stay open in the connector's private `opencode acp` server while the user keeps working in the TUI, and the connector would answer from a stale state.
- **Pros:** correct `lru` behaviour when the same opencode session is also used in the TUI.
- **Cons:** needs research on opencode's update marker and code in the session core.
- **Context:** compare `updatedAt` from ACP `session/list` (cwd filter) with the value seen at load/after our own turns; reload on change. The default `after_turn` lifecycle is unaffected (every turn ends with `session/close`, the next prompt loads fresh). Not verified live.
- **Depends on:** opencode v2 support (configOptions modes, v2 plugin).

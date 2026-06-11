export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = [
    "Search across project memories, indexed git commits, raw conversation history, and long-term external knowledge.",
    "",
    "Sources:",
    "- memory: curated cross-session knowledge (highest-signal; already-visible ones are filtered out)",
    "- message: raw user/assistant messages from older compartmentalized history",
    "- git_commit: HEAD git commits (enabled when experimental.git_commit_indexing is on)",
    "- external: long-term knowledge from past sessions (only fired on explicit ctx_search calls; requires memory.external.recall.search=true; first-call latency)",
    "",
    "Narrow via the `sources` param when the question maps to a specific channel:",
    '- "was this working before / when did this break" → ["git_commit", "message"]',
    '- "when did we change this" → ["git_commit"]',
    '- "what is our naming convention" → ["memory"]',
    '- "did we discuss this earlier" → ["message"]',
    '- "is there anything relevant from prior sessions" → ["external"]',
    "Omit sources for a broad search across all enabled channels.",
    "",
    "Memories already rendered in <session-history> are hard-filtered from results — the agent already sees them in context.",
    "External hits already injected this session via the <external-memory> block are filtered out for the same reason.",
    "Session facts are NOT a search source; they're always visible in <session-history>.",
    "Message results include ordinals the agent can pass to ctx_expand for full context.",
].join("\n");
export const DEFAULT_CTX_SEARCH_LIMIT = 10;

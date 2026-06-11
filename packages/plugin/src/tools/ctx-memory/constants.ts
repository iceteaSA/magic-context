export const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export const CTX_MEMORY_DESCRIPTION = `Manage cross-session project memories. Primary sessions can write new memories or delete stale ones. Dreamer sessions can also list, update, merge, archive, and verify memories. Memories persist across sessions and are automatically injected into new sessions.

Supported actions: write, delete, list, update, merge, archive, verify.

Write supports an optional 'scope': "project" (default) for this project's store, or "global" for cross-project facts (infrastructure, tooling, environment) stored only in the external long-term memory backend.`;
export const DEFAULT_SEARCH_LIMIT = 10;

import type { PromptSurfacePreset } from "../shared/prompt-surface";

export const FULL_PARAMETER_DESCRIPTIONS = {
    ctx_reduce: {
        drop: 'Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".',
    },
    ctx_expand: {
        start: "First ordinal of the range — a compartment's start, or an ordinal from a ctx_search hit.",
        end: "Last ordinal of the range, inclusive — a compartment's end.",
        verbose:
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        message:
            "Recover ONE message in full by ordinal (all text, all tool inputs and outputs). Use alone, without start/end.",
    },
    ctx_note: {
        action: "write | read | update | dismiss. Defaults to write when content is given, else read.",
        content:
            "Note text for write/update: first line is the title (under 80 chars), then the detail.",
        surface_condition:
            "Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds.",
        filter: "Read filter: active (default: active + ready), all, pending (unsurfaced smart notes), ready, dismissed.",
        limit: "Rows per read (default 25).",
        offset: "Skip this many newest rows (default 0).",
        note_ids:
            "Note ids: one for update, 1–50 for dismiss, any number for read (returns full bodies). Ignored by write.",
    },
    ctx_memory: {
        action: "write | update | archive | merge | get",
        content: "The memory text — one standalone fact (write, update, merge).",
        category:
            "Kind of fact (required for write; on update/merge optional, omitted keeps the current category).",
        ids: "Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get.",
        limit: "Max results for list (default 10).",
        reason: "Why it is being archived (optional).",
    },
    ctx_search: {
        query: "A natural-language question carrying the exact terms you expect in the answer.",
        limit: "Maximum results (default 10).",
        sources: "Restrict to these sources; omit for all. [] searches none.",
        from: "Earliest date, YYYY-MM-DD (inclusive).",
        to: "Latest date, YYYY-MM-DD (inclusive; default open).",
    },
    // Fork skill-memory tools: full text matches each tool's own .describe() so
    // the full preset changes nothing; light is the compressed variant.
    ctx_skill_note: {
        skill: "The skill name (e.g. 'test-driven-development')",
        intent: "The task/intent context when this note was learned",
        kind: "Note type: 'gotcha' (non-obvious trap), 'discovery' (better approach found), 'fix' (error→solution), 'workflow' (step that must not be skipped). Do NOT use 'general' — general observations belong in ctx_memory.",
        delta: "The note content — concise, actionable, specific to this skill",
        tags: "Optional tags for future filtering",
    },
    ctx_skill_recall: {
        skill: "The skill name to recall notes for (e.g. 'test-driven-development')",
        intent: "Optional: your current task intent — used for intent-scoped recall (P2). Omit for flat recall.",
        max_tokens:
            "Optional token budget override. Defaults to the skill's frontmatter max_tokens (or 1500 if absent).",
    },
} as const;

export const LIGHT_PARAMETER_DESCRIPTIONS = {
    ctx_reduce: {
        drop: 'Tag IDs: "3-5", "1,2,9", "1-5,8,12-15".',
    },
    ctx_expand: {
        start: "First ordinal — a compartment's start or a search hit.",
        end: "Last ordinal, inclusive.",
        verbose: "With start/end: one entry per message with previews instead of the transcript.",
        message: "Recover ONE message in full by ordinal; use without start/end.",
    },
    ctx_note: {
        action: "write | read | update | dismiss (default: write with content, else read).",
        content: "Note text: first line title (<80 chars), then detail.",
        surface_condition:
            "A condition an outside checker can verify on its own, periodically (repository, releases, web — anything it can look up); never something only this conversation knows.",
        filter: "Read filter: active (default), all, pending, ready, dismissed.",
        limit: "Rows per read (default 25).",
        offset: "Skip newest rows (default 0).",
        note_ids:
            "One id for update, 1–50 for dismiss, any for read (full bodies). Ignored by write.",
    },
    ctx_memory: {
        action: "write | update | archive | merge | get",
        content: "One standalone fact (write, update, merge).",
        category: "Kind of fact (required for write; optional on update/merge).",
        ids: "Ids from <project-memory>: one for update, 1+ for archive, 2+ for merge, 1–20 for get.",
        limit: "Max results for list (default 10).",
        reason: "Why it is archived (optional).",
    },
    ctx_search: {
        query: "A natural-language question carrying the exact terms you expect in the answer.",
        limit: "Maximum results (default 10).",
        sources: "Restrict to these sources; omit for all.",
        from: "Earliest date, YYYY-MM-DD (inclusive).",
        to: "Latest date, YYYY-MM-DD (inclusive; default open).",
    },
    ctx_skill_note: {
        skill: "Skill name.",
        intent: "Task context when the lesson was learned.",
        kind: "gotcha | discovery | fix | workflow (general facts go to ctx_memory).",
        delta: "The lesson, concise and skill-specific.",
        tags: "Optional filter tags.",
    },
    ctx_skill_recall: {
        skill: "Skill name.",
        intent: "Optional current intent for scoped recall.",
        max_tokens: "Optional token budget (default: frontmatter or 1500).",
    },
} as const;

export type PromptSurfaceParameterToolId = keyof typeof FULL_PARAMETER_DESCRIPTIONS;

export function parameterDescriptionsFor(
    toolId: string,
    preset: PromptSurfacePreset,
): Readonly<Record<string, string>> | undefined {
    const descriptions =
        preset === "light" ? LIGHT_PARAMETER_DESCRIPTIONS : FULL_PARAMETER_DESCRIPTIONS;
    return descriptions[toolId as PromptSurfaceParameterToolId];
}

export function applyJsonSchemaParameterDescriptions(
    toolId: string,
    input: unknown,
    preset: PromptSurfacePreset,
): void {
    const descriptions = parameterDescriptionsFor(toolId, preset);
    if (!descriptions || !input || typeof input !== "object") return;
    const properties = (input as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object") return;
    for (const [name, description] of Object.entries(descriptions)) {
        const property = (properties as Record<string, unknown>)[name];
        if (property && typeof property === "object") {
            (property as { description?: string }).description = description;
        }
    }
}

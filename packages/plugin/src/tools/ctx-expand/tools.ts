import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { resolveRootSessionId } from "../../features/magic-context/session-parent-registry";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import { resolveCtxExpandMode } from "./mode";
import { renderMessageByOrdinal, renderVerboseRange } from "./render";
import type { CtxExpandArgs } from "./types";

export { CTX_EXPAND_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
}

const ctxExpandArgsShape = {
    start: tool.schema
        .number()
        .optional()
        .describe(
            "First ordinal of the range — a compartment's start, or an ordinal from a ctx_search hit.",
        ),
    end: tool.schema
        .number()
        .optional()
        .describe("Last ordinal of the range, inclusive — a compartment's end."),
    verbose: tool.schema
        .boolean()
        .optional()
        .describe(
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        ),
    message: tool.schema
        .number()
        .optional()
        .describe(
            "Recover ONE message in full by ordinal (all text, all tool inputs and outputs). Use alone, without start/end.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxExpandArgsSchema = tool.schema.object(ctxExpandArgsShape).passthrough();

function createCtxExpandTool(deps: CtxExpandToolDeps): ToolDefinition {
    return tool({
        description: CTX_EXPAND_DESCRIPTION,
        args: ctxExpandArgsShape,
        async execute(rawArgs: CtxExpandArgs, toolContext) {
            const parsedArgs = ctxExpandArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxExpandArgs;
            args = unwrapImitatedReducedArgs(args, ["message", "start"], {
                start: "number",
                end: "number",
                verbose: "boolean",
                message: "number",
            });
            // Resolve child sessions (dreamer, task subagents) to the ROOT
            // conversation — ctx_search hands out ordinals from the root
            // session's message index, so expanding them against the child's
            // empty session would always miss. Mirrors ctx_search.
            const sessionId = resolveRootSessionId(toolContext.sessionID);
            // Upstream's resolveCtxExpandMode now owns by-ordinal validation that
            // this fork used to inline here; keep the shared validator and only
            // retain the root-session resolution above.
            const mode = resolveCtxExpandMode(args, "positive");
            if (mode.kind === "error") {
                return mode.message;
            }
            if (mode.kind === "message") {
                return renderMessageByOrdinal(sessionId, mode.message);
            }
            const { start, end, verbose } = mode;

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
                return `Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
            }
            const effectiveEnd = lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;

            // Verbose mode: each message separate, with ids + per-part previews.
            if (verbose) {
                const v = renderVerboseRange(
                    sessionId,
                    start,
                    effectiveEnd,
                    CTX_EXPAND_TOKEN_BUDGET,
                );
                if (!v.text) {
                    return `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`;
                }
                const out = [
                    `Messages ${start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
                    "",
                    v.text,
                ];
                if (v.truncated) {
                    out.push(
                        "",
                        `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
                    );
                }
                return out.join("\n");
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return `No messages found in range ${start}-${end}. The range may be outside this session's history.`;
            }

            const lines: string[] = [];
            lines.push(
                `Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
            );
            lines.push("");
            lines.push(chunk.text);

            if (chunk.endIndex < effectiveEnd) {
                lines.push("");
                lines.push(
                    `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
                );
            }

            return lines.join("\n");
        },
    });
}

export function createCtxExpandTools(deps: CtxExpandToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_expand: createCtxExpandTool(deps),
    };
}

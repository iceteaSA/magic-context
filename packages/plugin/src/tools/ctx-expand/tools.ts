import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { resolveRootSessionId } from "../../features/magic-context/session-parent-registry";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import type { CtxExpandArgs } from "./types";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
}

function createCtxExpandTool(deps: CtxExpandToolDeps): ToolDefinition {
    return tool({
        description: CTX_EXPAND_DESCRIPTION,
        args: {
            start: tool.schema
                .number()
                .describe("Start message ordinal (from compartment start attribute)"),
            end: tool.schema
                .number()
                .describe("End message ordinal (from compartment end attribute)"),
        },
        async execute(args: CtxExpandArgs, toolContext) {
            // Resolve child sessions (sidekick, task subagents) to the ROOT
            // conversation — ctx_search hands out ordinals from the root
            // session's message index, so expanding them against the child's
            // empty session would always miss. Mirrors ctx_search.
            const sessionId = resolveRootSessionId(toolContext.sessionID);

            if (!args.start || !args.end || args.start < 1 || args.end < args.start) {
                return "Error: start and end must be positive integers with start <= end.";
            }

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && args.start > lastCompartmentEnd) {
                return `Range ${args.start}-${args.end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
            }
            const effectiveEnd =
                lastCompartmentEnd >= 0 ? Math.min(args.end, lastCompartmentEnd) : args.end;

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                args.start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return `No messages found in range ${args.start}-${args.end}. The range may be outside this session's history.`;
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

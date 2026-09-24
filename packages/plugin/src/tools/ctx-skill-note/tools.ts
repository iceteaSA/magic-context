import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin";
import { cosineSimilarity } from "../../features/magic-context/memory/cosine-similarity";
import { embedTextForProject } from "../../features/magic-context/memory/embedding";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    float32ArrayToBlob,
    toFloat32Array,
} from "../../features/magic-context/memory/storage-memory-embeddings";
import { computeSkillContentHash } from "../../features/magic-context/skill-memory/content-hash";
import { parseFrontmatterConfig } from "../../features/magic-context/skill-memory/frontmatter";
import {
    getSkillLoad,
    resolveSkillPathByName,
    type SkillProvenance,
} from "../../features/magic-context/skill-memory/provenance";
import {
    bumpHitCount,
    bumpHitCountById,
    findExistingNote,
    getDedupCandidates,
    insertSkillMemoryNote,
    partitionKey,
} from "../../features/magic-context/skill-memory/storage";
import {
    CTX_SKILL_NOTE_TOOL_NAME,
    type CtxSkillNoteArgs,
    type CtxSkillNoteToolDeps,
    VALID_KINDS,
} from "./types";

// NOTE on tool() API: the real @opencode-ai/plugin tool() takes:
//   { description, args: ZodRawShape, execute(args, context: ToolContext) }
// `name` is registry-level (passed when registering, not inside tool body).
// `args` uses tool.schema.* (Zod-like) for field definitions, NOT a JSON Schema object.
// See packages/plugin/src/tools/ctx-memory/tools.ts for the canonical pattern.
//
// The tool body below uses the correct API shape. The `name` field is intentionally
// absent from the tool() call — it is provided at registration time in the tool registry.

export function createCtxSkillNoteTool(deps: CtxSkillNoteToolDeps): ToolDefinition {
    return tool({
        description:
            "Record a skill-specific note (gotcha, discovery, fix, or workflow step) for future recall. " +
            "Call after using a skill when you hit a non-obvious issue, found a better approach, or fixed a skill-specific error. " +
            "Skip routine successes. Notes are recalled automatically on the next load of the same skill.",
        args: {
            skill: tool.schema.string().describe("The skill name (e.g. 'test-driven-development')"),
            intent: tool.schema
                .string()
                .describe("The task/intent context when this note was learned"),
            kind: tool.schema
                .enum(VALID_KINDS)
                .describe(
                    "Note type: 'gotcha' (non-obvious trap), 'discovery' (better approach found), " +
                        "'fix' (error→solution), 'workflow' (step that must not be skipped). " +
                        "Do NOT use 'general' — general observations belong in ctx_memory.",
                ),
            delta: tool.schema
                .string()
                .describe("The note content — concise, actionable, specific to this skill"),
            tags: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe("Optional tags for future filtering"),
        },
        execute: async (args: CtxSkillNoteArgs, toolContext: ToolContext) => {
            // Hard gate: reject kind='general'
            if ((args.kind as string) === "general") {
                return (
                    "'kind: general' is not a valid skill-memory note type. " +
                    "General observations belong in `ctx_memory` with an appropriate category " +
                    "(e.g. PROJECT_RULES, CONSTRAINTS, ARCHITECTURE). " +
                    "Use ctx_skill_note only for gotchas, discoveries, fixes, or workflow steps specific to this skill."
                );
            }

            if (!VALID_KINDS.includes(args.kind)) {
                return `Invalid kind '${args.kind}'. Must be one of: ${VALID_KINDS.join(", ")}.`;
            }

            const sessionId = toolContext.sessionID;
            if (!sessionId) return "Error: no session ID available.";

            const projectDirectory = toolContext.directory;
            const registryEntry = deps.skillLoadRegistry
                ? getSkillLoad(deps.skillLoadRegistry, sessionId, args.skill)
                : undefined;

            let resolvedPath: string;
            let tier: SkillProvenance["tier"];
            let skillSource: SkillProvenance["skillSource"];
            let frontmatterConfig = registryEntry?.frontmatterConfig ?? null;

            if (registryEntry) {
                resolvedPath = registryEntry.resolvedPath;
                tier = registryEntry.tier;
                skillSource = registryEntry.skillSource;
            } else {
                const resolved = resolveSkillPathByName(args.skill, projectDirectory);
                if (!resolved) {
                    return (
                        `SKILL.md not found for '${args.skill}' in any known skill directory. ` +
                        `Load the skill first with the skill tool, or verify the skill name is correct. ` +
                        `Searched: project .opencode/skill/, .opencode/skills/, .agents/skills/, .claude/skills/; ` +
                        `global ~/.config/opencode/skill/, ~/.config/opencode/skills/, ~/.agents/skills/, ~/.claude/skills/.`
                    );
                }

                resolvedPath = resolved.resolvedPath;
                tier = resolved.tier;
                skillSource = resolved.skillSource;
                let rawSkillContent: string | null = null;
                try {
                    rawSkillContent = readFileSync(resolvedPath, "utf-8");
                } catch {
                    // The file can disappear between resolution and read; preserve the not-enabled gate.
                }
                frontmatterConfig = rawSkillContent
                    ? parseFrontmatterConfig(rawSkillContent)
                    : null;
            }

            // Counterpart to ctx_skill_recall's enabled-guard: without it, notes for
            // skills that never opted in would insert successfully but be permanently
            // orphaned (recallSkillMemoryBlock returns "" when frontmatter is disabled),
            // while the agent sees a convincing "Skill note saved" response.
            if (!frontmatterConfig?.enabled) {
                return (
                    `skill-memory is not enabled for '${args.skill}', so this note would never be surfaced. ` +
                    `To enable it, add \`skill-memory: { enabled: true }\` to the skill's SKILL.md frontmatter, reload the skill, then record the note.`
                );
            }

            // Use toolContext.directory (the session's working directory) rather than
            // a launch dir. This matches ctx_memory's pattern and correctly handles
            // `opencode -s` launched outside the project root.
            const projectIdentity = resolveProjectIdentity(projectDirectory);
            const part = partitionKey(tier, projectIdentity);
            const normalizedHash = computeNormalizedHash(args.delta);

            // Content-hash of the resolved skill folder: stamp every note write so
            // recall can flag notes recorded against an older SKILL.md. Best-effort —
            // an unreadable folder stores NULL and the note still persists.
            const skillContentHash = computeSkillContentHash(dirname(resolvedPath));

            // Check for exact duplicate
            const existing = findExistingNote(deps.db, args.skill, tier, part, normalizedHash);
            if (existing) {
                // Dedup re-record refreshes the stored hash when known — re-recording
                // the same lesson against the current version re-validates it.
                bumpHitCount(deps.db, args.skill, tier, part, normalizedHash, skillContentHash);
                return (
                    `Note already recorded (hit_count now ${existing.hit_count + 1}). ` +
                    `Exact duplicate detected — hit count bumped to reinforce recall priority.`
                );
            }

            // Embed both fields (best-effort; null on provider-off/unseeded — note still inserts).
            let intentEmb = await embedTextForProject(projectIdentity, args.intent);
            const deltaEmb = await embedTextForProject(projectIdentity, args.delta);
            // Guard mixed vector spaces: if a re-registration happened between the two embeds, discard intent to keep one space.
            if (intentEmb && deltaEmb && intentEmb.modelId !== deltaEmb.modelId) {
                intentEmb = null;
            }
            const modelVersion = deltaEmb?.modelId ?? intentEmb?.modelId ?? null;

            // Delta-only semantic dedup (bounded top-200, model-matched).
            if (deltaEmb) {
                const cands = getDedupCandidates(deps.db, args.skill, tier, part, 200);
                const threshold = frontmatterConfig?.dedup_threshold ?? 0.92;
                for (const c of cands) {
                    if (!c.delta_embedding || c.embedding_model_version !== deltaEmb.modelId)
                        continue;
                    if (
                        cosineSimilarity(deltaEmb.vector, toFloat32Array(c.delta_embedding)) >=
                        threshold
                    ) {
                        // Same re-validation as the exact-hash dedup path:
                        // if we can resolve a fresh hash, refresh the stored one.
                        if (skillContentHash) {
                            deps.db
                                .prepare(
                                    `UPDATE skill_memory SET skill_content_hash = ? WHERE id = ?`,
                                )
                                .run(skillContentHash, c.id);
                        }
                        bumpHitCountById(deps.db, c.id);
                        return "Note already recorded (semantic duplicate — hit_count bumped).";
                    }
                }
            }

            // Insert new note
            const id = insertSkillMemoryNote(deps.db, {
                skillId: args.skill,
                resolvedPath,
                tier,
                skillSource,
                projectIdentity: part,
                originProject: projectIdentity,
                intent: args.intent,
                kind: args.kind,
                delta: args.delta,
                tags: args.tags,
                normalizedHash,
                intentEmbedding: intentEmb ? float32ArrayToBlob(intentEmb.vector) : null,
                deltaEmbedding: deltaEmb ? float32ArrayToBlob(deltaEmb.vector) : null,
                embeddingModelVersion: modelVersion,
                createdAt: Date.now(),
                skillContentHash,
            });

            if (id === null) {
                // Race condition: another process inserted the same hash
                bumpHitCount(deps.db, args.skill, tier, part, normalizedHash, skillContentHash);
                return "Note already recorded (concurrent insert detected — hit count bumped).";
            }

            return (
                `Skill note saved (id=${id}, skill=${args.skill}, kind=${args.kind}, tier=${tier}). ` +
                `It will be recalled on the next load of '${args.skill}' in this project.`
            );
        },
    });
}

// Re-export the tool name for the registration site (lives in plugin/tool-registry.ts).
export { CTX_SKILL_NOTE_TOOL_NAME };

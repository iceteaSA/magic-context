import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { embedTextForProject } from "./embedding";
import { teeToExternalBackend } from "./external-memory";
import type { ExternalMemoryRetainItem } from "./external-memory-provider";
import { computeNormalizedHash } from "./normalize-hash";
import {
    getMemoryByHash,
    getMemoryById,
    insertMemory,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
import type { MemoryCategory, MemoryInput } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
    category: MemoryCategory;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
): PromotedMemoryRef[] {
    const refs: PromotedMemoryRef[] = [];
    for (const fact of facts) {
        if (
            !fact ||
            typeof fact.category !== "string" ||
            typeof fact.content !== "string" ||
            fact.content.trim().length === 0
        ) {
            continue;
        }
        if (!isPromotableCategory(fact.category)) {
            continue;
        }

        const normalizedHash = computeNormalizedHash(fact.content);
        const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

        if (existingMemory) {
            updateMemorySeenCount(db, existingMemory.id);
            continue;
        }

        const memoryInput: MemoryInput = {
            projectPath,
            category: fact.category,
            content: fact.content,
            sourceSessionId: sessionId,
            sourceType: "historian",
            expiresAt: resolveExpiresAt(fact.category),
        };

        const memory = insertMemory(db, memoryInput);
        refs.push({ memoryId: memory.id, content: memory.content, category: fact.category });
    }

    return refs;
}

/**
 * Best-effort asynchronous post-commit side effects for newly promoted facts:
 * (1) embed each into the project vector store, and (2) fire-and-forget tee the
 * batch to the external memory backend. Must run AFTER the durable publish
 * transaction commits so only durably-persisted facts are embedded and teed.
 */
export async function embedPromotedFacts(
    db: Database,
    sessionId: string,
    projectPath: string,
    refs: PromotedMemoryRef[],
    options?: { projectName?: string },
): Promise<void> {
    for (const ref of refs) {
        await embedAndStoreMemory(db, sessionId, projectPath, ref.memoryId, ref.content);
    }

    // Fire-and-forget batched external tee — never blocks or fails promotion.
    // Lives in the post-commit phase so only durably-persisted facts are teed
    // (mirrors the embedding gating above).
    if (refs.length > 0) {
        const teedItems: ExternalMemoryRetainItem[] = refs.map((ref) => ({
            content: ref.content,
            category: ref.category,
            scope: "project",
            projectIdentity: projectPath,
            ...(options?.projectName ? { projectName: options.projectName } : {}),
            sourceType: "historian",
            sessionId,
        }));
        void teeToExternalBackend("historian", teedItems);
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    memoryId: number,
    content: string,
): Promise<void> {
    try {
        // Capture the row's content hash BEFORE the async provider call: the
        // vector it returns is only valid for the content stored right now. If
        // the memory is edited while the call is in flight, the row's
        // normalized_hash changes and the guarded save below discards the stale
        // vector instead of resurrecting an out-of-date row — the memory then
        // stays unembedded until the proactive drain re-embeds current content.
        const hashBeforeEmbed = getMemoryById(db, memoryId)?.normalizedHash;
        if (!hashBeforeEmbed) {
            return;
        }
        const result = await embedTextForProject(projectPath, content);
        if (result) {
            db.transaction(() => {
                saveEmbeddingIfHashMatches(
                    db,
                    memoryId,
                    result.vector,
                    result.modelId,
                    hashBeforeEmbed,
                );
            })();
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}

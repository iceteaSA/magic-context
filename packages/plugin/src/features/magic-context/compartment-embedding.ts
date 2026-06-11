import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { embedTextForProject } from "./project-embedding-registry";

/**
 * Compartment P1 embedding (v2 / E2).
 *
 * The LOCKED substrate decision: `p1_embedding` is computed + stored on EVERY
 * compartment publish, even though the historian no longer uses embedding to
 * pick its own reference block (that switched to recency). The embedding exists
 * for two consumers:
 *   - ctx_search semantic retrieval over compartments (E2 consumption),
 *   - future dreamer cross-compartment linking (e.g. "key-files 2 months ago
 *     ↔ key-files now").
 *
 * Fire-and-forget + best-effort, mirroring memory promotion: a missing/slow
 * embedding provider must never block or fail a historian publish. Gated by
 * `embedding.provider !== "off"` at the runner call sites (no endpoint hits
 * when embeddings are off); independent of the memory store flags.
 */

interface CompartmentToEmbed {
    id: number;
    /** P1 tier text (fullest) — the embedding source. */
    p1: string;
}

/**
 * Embed the P1 text of the given compartments and persist each vector into
 * `compartments.p1_embedding` (+ `p1_embedding_model_id`). Best-effort per row:
 * one failure logs and continues. Never throws.
 *
 * `embedTextForProject` resolves the project's configured provider/model, so the
 * stored `model_id` stays consistent with memory embeddings for the same project
 * (vector compatibility for cross-corpus search later).
 */
export async function embedAndStoreCompartments(
    db: Database,
    sessionId: string,
    projectPath: string,
    compartments: readonly CompartmentToEmbed[],
): Promise<void> {
    if (compartments.length === 0) return;
    const update = db.prepare(
        "UPDATE compartments SET p1_embedding = ?, p1_embedding_model_id = ? WHERE id = ?",
    );
    for (const c of compartments) {
        if (!c.p1 || c.p1.length === 0) continue;
        try {
            const result = await embedTextForProject(projectPath, c.p1);
            if (result) {
                const blob = Buffer.from(
                    result.vector.buffer,
                    result.vector.byteOffset,
                    result.vector.byteLength,
                );
                update.run(blob, result.modelId, c.id);
            }
        } catch (error) {
            sessionLog(sessionId, `compartment embedding failed for compartment ${c.id}:`, error);
        }
    }
}

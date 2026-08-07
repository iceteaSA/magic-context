/**
 * Downstream-lane migrations owned by this fork.
 *
 * Upstream reserves `schema_migrations` versions below
 * `FORK_MIGRATION_VERSION_FLOOR` (10000) for itself and everything at or above
 * it for forks sharing `context.db` (docs/migration-version-lanes.md). This
 * module holds our side of that boundary.
 *
 * Why a separate array and runner instead of appending to `MIGRATIONS`:
 *
 *  1. Upstream appends new migrations at the end of the `MIGRATIONS` literal.
 *     A fork entry living there collides on essentially every release. Keeping
 *     our entries out of that array removes the conflict surface entirely.
 *  2. `LATEST_MIGRATION_VERSION` is a bare max over `MIGRATIONS`, and the
 *     schema fence asserts it equals `LATEST_SUPPORTED_VERSION`. A fork version
 *     inside that array would drag the fence ceiling to 10100+ — above anything
 *     upstream's `getPersistedVersion()` can return, since that reads
 *     `MAX(version) WHERE version < FORK_MIGRATION_VERSION_FLOOR`.
 *  3. A dozen upstream migration tests assert the newest `schema_migrations`
 *     row equals `LATEST_MIGRATION_VERSION`. Applying fork rows inside
 *     `runMigrations` would break all of them and force permanent divergence in
 *     upstream-owned test files.
 *
 * So `runMigrations()` stays byte-identical to upstream and `runForkMigrations()`
 * runs as a second pass from the real open path in storage-db.ts.
 *
 * Subrange allocation for this fork (we are our own allocator; upstream provides
 * one lane, not a registry):
 *
 *   10000-10099  skill-memory
 *   10100-10199  external memory
 */

import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    FORK_MIGRATION_VERSION_FLOOR,
    isSiblingMigrationConflict,
    isSqliteLockError,
    type Migration,
    MigrationLockBusyError,
} from "./migrations";
import { ensureColumn } from "./storage-schema-helpers";

export const FORK_MIGRATIONS: Migration[] = [
    {
        // External memory v2: session recall snapshot + m[0] recall marker.
        //
        // Renumbered nine times chasing the upstream lane
        // (v31→33→37→38→39→42→50→73→75): every release that claimed the next
        // version forced a move, and twice the resulting collision made the
        // runner skip a real migration body, needing live-DB surgery to repair.
        // The downstream lane ends that class of failure — a fork row sits above
        // the upstream watermark, so no upstream version can collide with it.
        //
        // The body is ensureColumn-idempotent, so a dev DB that already ran this
        // under any earlier number re-applies harmlessly.
        version: 10_100,
        description: "External memory v2: session recall snapshot + m[0] recall marker",
        up: (db: Database) => {
            // session_meta existence guard — see v30's comment (partial test fixtures).
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            // Per-session external recall snapshot (post-dedup, post-trim) — the
            // frozen content every render replays for byte stability.
            ensureColumn(db, "session_meta", "external_recall_json", "TEXT");
            ensureColumn(db, "session_meta", "external_recall_state", "TEXT");
            ensureColumn(db, "session_meta", "external_recall_at", "INTEGER");
            // m[0] marker: hash of the external content baked into the cached m[0]
            // ('' = none). NOT a mustMaterialize trigger — drives only the m[1]
            // <external-memory> delta comparison. No cache-clear needed: the
            // cachedRowMatchesState comparison normalizes NULL and '' to equal.
            ensureColumn(db, "session_meta", "cached_m0_external_recall_hash", "TEXT");
        },
    },
];

/**
 * Highest version this fork owns in the downstream lane, or 0 when the branch
 * carries no fork migrations.
 *
 * NOT a schema fence: nothing refuses to open a database because of it, because
 * fork rows are fence-invisible by design. It exists so fork-owned migration
 * tests can assert against the lane they live in instead of hardcoding a literal
 * that drifts whenever a subrange is reallocated.
 */
export const LATEST_FORK_MIGRATION_VERSION: number = FORK_MIGRATIONS.reduce(
    (max, migration) => Math.max(max, migration.version),
    0,
);

function schemaMigrationsTableExists(db: Database): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1",
            )
            .get() != null
    );
}

function isForkMigrationApplied(db: Database, version: number): boolean {
    return db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version) != null;
}

/**
 * Apply pending downstream-lane migrations.
 *
 * Selection is by per-row presence only — deliberately NOT by the
 * `version > currentVersion` watermark upstream uses. Upstream's watermark reads
 * `MAX(version) WHERE version < FORK_MIGRATION_VERSION_FLOOR`, so it can never
 * describe fork rows; checking each row directly is what makes this pass immune
 * to the renumber-collision skip that previously required manual DB repair.
 *
 * Requires `schema_migrations` to exist, which `runMigrations()` guarantees.
 * Callers must run the upstream pass first; a fork migration's DDL may depend on
 * upstream tables.
 *
 * Each migration runs in its own immediate transaction, matching upstream's
 * per-migration isolation: a failure rolls back only that migration.
 */
export function runForkMigrations(db: Database): void {
    if (FORK_MIGRATIONS.length === 0) return;
    if (!schemaMigrationsTableExists(db)) {
        throw new Error(
            "runForkMigrations requires the schema_migrations table; call runMigrations(db) first",
        );
    }

    const ordered = [...FORK_MIGRATIONS].sort((a, b) => a.version - b.version);
    let loggedPlan = false;

    for (const migration of ordered) {
        if (migration.version < FORK_MIGRATION_VERSION_FLOOR) {
            // Fail loudly rather than silently corrupting the upstream lane: a
            // fork migration below the floor would be swept into upstream's
            // watermark and could make its runner skip a real upstream body.
            throw new Error(
                `Fork migration v${migration.version} is below the downstream floor ${FORK_MIGRATION_VERSION_FLOOR}`,
            );
        }

        try {
            const applied = db
                .transaction(() => {
                    if (isForkMigrationApplied(db, migration.version)) return false;
                    if (!loggedPlan) {
                        const pending = ordered.filter(
                            (candidate) => !isForkMigrationApplied(db, candidate.version),
                        ).length;
                        log(`[migrations] fork lane: applying ${pending} downstream migration(s)`);
                        loggedPlan = true;
                    }
                    migration.up(db);
                    db.prepare(
                        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                    ).run(migration.version, migration.description, Date.now());
                    return true;
                })
                .immediate();

            if (applied) {
                log(`[migrations] applied fork v${migration.version}: ${migration.description}`);
            }
        } catch (error) {
            if (isSqliteLockError(error)) {
                throw new MigrationLockBusyError(
                    `failed to acquire migration write lock for fork v${migration.version}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
            if (isSiblingMigrationConflict(db, error, migration.version)) {
                log(
                    `[migrations] fork v${migration.version} already applied by sibling instance — continuing`,
                );
                continue;
            }
            const detail = error instanceof Error ? error.message : String(error);
            log(
                `[migrations] FAILED fork v${migration.version}: ${migration.description} — ${detail}`,
            );
            throw new Error(
                `Fork migration v${migration.version} failed: ${detail}. Database may need manual repair.`,
            );
        }
    }
}

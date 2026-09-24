import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    FORK_MIGRATIONS,
    LATEST_FORK_MIGRATION_VERSION,
    runForkMigrations,
} from "./fork-migrations";
import { FORK_MIGRATION_VERSION_FLOOR, MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function migratedDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    runForkMigrations(db);
    return db;
}

describe("migration v10003 (fork lane) — skill_content_hash column", () => {
    test("adds the skill_content_hash column on a fresh DB", () => {
        const db = migratedDb();
        try {
            const cols = (
                db.prepare("PRAGMA table_info(skill_memory)").all() as Array<{ name: string }>
            ).map((c) => c.name);
            expect(cols).toContain("skill_content_hash");
        } finally {
            closeQuietly(db);
        }
    });

    test("running it twice is a no-op (idempotent via columnExists)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runForkMigrations(db);
            runForkMigrations(db);
            runForkMigrations(db);
            // Column still present, no error, no duplicate.
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM pragma_table_info('skill_memory') WHERE name='skill_content_hash'",
                )
                .get() as { n: number };
            expect(row.n).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("applies on an existing database whose fork lane already records v10100", () => {
        // Live databases reached 10100 before 10003 existed, so 10003 is a gap
        // below the lane maximum. The runner must apply it by per-version check,
        // not skip it because a higher fork version is already recorded.
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            for (const m of FORK_MIGRATIONS.filter((m) => m.version !== 10_003)) {
                m.up(db);
                db.prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                ).run(m.version, m.description, 0);
            }
            const hasColumn = () =>
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM pragma_table_info('skill_memory') WHERE name='skill_content_hash'",
                        )
                        .get() as { n: number }
                ).n;
            expect(hasColumn()).toBe(0);

            runForkMigrations(db);

            expect(hasColumn()).toBe(1);
            const recorded = db
                .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?")
                .get(10_003) as { n: number };
            expect(recorded.n).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("column has no default — pre-existing rows stay NULL", () => {
        // Seed a row under the pre-10003 schema, then run 10003; the row's
        // new column must be NULL (NOT backfilled per the spec).
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            // Same pattern as the v10002 test: apply early migrations via
            // up() to materialize skill_memory + the prior fork columns,
            // but stop before the upstream migration that creates
            // schema_migrations (which the runner does, not any single up()).
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            for (const m of FORK_MIGRATIONS.filter((m) => m.version <= 10_002)) m.up(db);
            // Sanity: skill_memory exists, column does not yet.
            const before = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM pragma_table_info('skill_memory') WHERE name='skill_content_hash'",
                )
                .get() as { n: number };
            expect(before.n).toBe(0);
            // Seed a row.
            db.prepare(
                `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,delta,kind,normalized_hash,hit_count,pinned,created_at)
                 VALUES ('s','/p','global','*','i','d','fix','h',0,0,1)`,
            ).run();
            // Apply 10003.
            const v10003 = FORK_MIGRATIONS.find((m) => m.version === 10_003);
            expect(v10003).toBeDefined();
            v10003?.up(db);
            // Pre-existing row's hash is NULL — no backfill.
            const row = db
                .prepare("SELECT skill_content_hash FROM skill_memory WHERE normalized_hash='h'")
                .get() as { skill_content_hash: string | null };
            expect(row.skill_content_hash).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("LATEST_FORK_MIGRATION_VERSION tracks the new fork-lane maximum (≥10003)", () => {
        // 10003 enters the fork lane; the existing 10100 (external-memory v2
        // session columns) stays the high-water mark — LATEST tracks the max,
        // not the most-recently-added. The lane-level invariant is that the
        // version is at or above the new migration.
        expect(LATEST_FORK_MIGRATION_VERSION).toBe(
            Math.max(...FORK_MIGRATIONS.map((m) => m.version)),
        );
        expect(LATEST_FORK_MIGRATION_VERSION).toBeGreaterThanOrEqual(10_003);
    });

    test("this migration lives in the fork lane, outside the schema fence", () => {
        // Fork rows are fence-invisible by design — LATEST_SUPPORTED_VERSION
        // stays at the upstream ceiling.
        expect(FORK_MIGRATIONS.some((m) => m.version === 10_003)).toBe(true);
        expect(LATEST_SUPPORTED_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
    });

    test("bookkeeping row appears under the schema_migrations table on a fresh DB", () => {
        const db = migratedDb();
        try {
            const row = db
                .prepare("SELECT description FROM schema_migrations WHERE version = 10003")
                .get() as { description: string } | null;
            expect(row).not.toBeNull();
            expect(row?.description).toContain("content hash");
        } finally {
            closeQuietly(db);
        }
    });
});

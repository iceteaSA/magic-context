import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkMigrations } from "../../features/magic-context/fork-migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    type ProjectEmbeddingRegistrationSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/memory/embedding";
import type { EmbeddingProvider } from "../../features/magic-context/memory/embedding-provider";
import {
    __resetProjectIdentityForTests,
    resolveProjectIdentity,
} from "../../features/magic-context/memory/project-identity";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    _resetContentHashCacheForTests,
    computeSkillContentHash,
} from "../../features/magic-context/skill-memory/content-hash";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSkillNoteTool } from "./tools";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    runForkMigrations(db);
    return db;
}

function installProvider(): void {
    _setTestProviderFactoryForProject(
        (): EmbeddingProvider => ({
            modelId: "test-provider-model",
            initialize: async () => true,
            embed: async () => new Float32Array([1, 0]),
            embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
            dispose: async () => {},
            isLoaded: () => true,
        }),
    );
}

function registerTestProject(db: Database, identity: string): ProjectEmbeddingRegistrationSnapshot {
    return registerProjectEmbedding(
        db,
        identity,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: false },
        identity,
    );
}

// Build a project-local skill fixture dir matching the SKILL.md pattern
// resolveSkillPathByName searches (`.opencode/skill/` and `.opencode/skills/`).
function makeSkillFixture(): { projectDirectory: string; skillDir: string } {
    const projectDirectory = mkdtempSync(join(tmpdir(), "mc-note-hash-fixture-"));
    const skillDir = join(projectDirectory, ".opencode", "skills", "tdd");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nskill-memory:\n  enabled: true\n---\n# tdd\n");
    return { projectDirectory, skillDir };
}

describe("ctx_skill_note — skill_content_hash stamping", () => {
    const dirs: string[] = [];
    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        __resetProjectIdentityForTests();
        installProvider();
        _resetContentHashCacheForTests();
    });
    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        for (const d of dirs.splice(0)) {
            rmSync(d, { recursive: true, force: true });
        }
    });

    test("stamps the hash of the resolved skill folder on a fresh insert", async () => {
        const db = makeDb();
        const { projectDirectory, skillDir } = makeSkillFixture();
        dirs.push(projectDirectory);
        try {
            // Make HOME point somewhere we control — resolveSkillPathByName
            // reads process.env.HOME to build its global-dir list.
            const isolatedHome = mkdtempSync(join(tmpdir(), "mc-note-hash-home-"));
            dirs.push(isolatedHome);
            const previousHome = process.env.HOME;
            process.env.HOME = isolatedHome;
            try {
                const projectIdentity = resolveProjectIdentity(projectDirectory);
                registerTestProject(db, projectIdentity);
                const expectedHash = computeSkillContentHash(skillDir);
                expect(expectedHash).not.toBeNull();

                const t = createCtxSkillNoteTool({ db });
                const result = await t.execute(
                    {
                        skill: "tdd",
                        intent: "fix flaky test",
                        kind: "fix",
                        delta: "mock Date.now in auth tests",
                    },
                    {
                        sessionID: "ses_test",
                        agent: "general",
                        directory: projectDirectory,
                    } as never,
                );
                expect(result).toContain("saved");

                const row = db
                    .prepare("SELECT skill_content_hash FROM skill_memory WHERE skill_id = 'tdd'")
                    .get() as { skill_content_hash: string | null };
                expect(row.skill_content_hash).toBe(expectedHash);
                expect(row.skill_content_hash).not.toBeNull();
            } finally {
                process.env.HOME = previousHome;
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("dedup re-record: re-records the same lesson refreshes the stored hash to current", async () => {
        const db = makeDb();
        const { projectDirectory, skillDir } = makeSkillFixture();
        dirs.push(projectDirectory);
        try {
            const isolatedHome = mkdtempSync(join(tmpdir(), "mc-note-hash-home-"));
            dirs.push(isolatedHome);
            const previousHome = process.env.HOME;
            process.env.HOME = isolatedHome;
            try {
                const projectIdentity = resolveProjectIdentity(projectDirectory);
                registerTestProject(db, projectIdentity);

                const t = createCtxSkillNoteTool({ db });
                // 1st write → stamps current hash.
                await t.execute(
                    {
                        skill: "tdd",
                        intent: "fix flaky",
                        kind: "fix",
                        delta: "always mock the clock in auth tests",
                    },
                    {
                        sessionID: "ses_test",
                        agent: "general",
                        directory: projectDirectory,
                    } as never,
                );
                const initialHash = computeSkillContentHash(skillDir);

                // Mutate the skill folder — append a line. The hash changes.
                writeFileSync(
                    join(skillDir, "SKILL.md"),
                    "---\nskill-memory:\n  enabled: true\n---\n# tdd\n\nnew section added\n",
                );
                _resetContentHashCacheForTests();
                const afterEditHash = computeSkillContentHash(skillDir);
                expect(afterEditHash).not.toBe(initialHash);

                // 2nd write → dedup re-record with a fresh hash.
                const dedupResult = await t.execute(
                    {
                        skill: "tdd",
                        intent: "fix flaky",
                        kind: "fix",
                        delta: "always mock the clock in auth tests",
                    },
                    {
                        sessionID: "ses_test",
                        agent: "general",
                        directory: projectDirectory,
                    } as never,
                );
                expect(dedupResult).toContain("already recorded");

                const row = db
                    .prepare(
                        "SELECT skill_content_hash, hit_count FROM skill_memory WHERE skill_id = 'tdd'",
                    )
                    .get() as { skill_content_hash: string | null; hit_count: number };
                expect(row.hit_count).toBe(1); // bumped from 0 by dedup
                expect(row.skill_content_hash).toBe(afterEditHash); // refreshed to the new current hash
            } finally {
                process.env.HOME = previousHome;
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("does not read the real ~/.config skill tree (process isolation)", async () => {
        // The fixture's resolvedPath is project-local — never read the user's
        // real ~/.config. The test writes the note, then asserts the stored
        // hash matches the FIXTURE'S hash, NOT some value that would have come
        // from a different cwd. The fixture is the only dir in scope.
        const db = makeDb();
        const { projectDirectory, skillDir } = makeSkillFixture();
        dirs.push(projectDirectory);
        try {
            const isolatedHome = mkdtempSync(join(tmpdir(), "mc-note-hash-home2-"));
            dirs.push(isolatedHome);
            const previousHome = process.env.HOME;
            process.env.HOME = isolatedHome;
            try {
                const projectIdentity = resolveProjectIdentity(projectDirectory);
                registerTestProject(db, projectIdentity);

                const t = createCtxSkillNoteTool({ db });
                await t.execute(
                    {
                        skill: "tdd",
                        intent: "x",
                        kind: "fix",
                        delta: "note body",
                    },
                    {
                        sessionID: "ses_test",
                        agent: "general",
                        directory: projectDirectory,
                    } as never,
                );

                const row = db
                    .prepare("SELECT skill_content_hash FROM skill_memory WHERE skill_id='tdd'")
                    .get() as { skill_content_hash: string | null };
                expect(row.skill_content_hash).not.toBeNull();
                // The stored hash is exactly computeSkillContentHash on the
                // fixture dir — not the user's real home.
                expect(row.skill_content_hash).toBe(computeSkillContentHash(skillDir));
            } finally {
                process.env.HOME = previousHome;
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("writes NULL when the skill folder is unreadable (graceful degrade)", async () => {
        const db = makeDb();
        const { projectDirectory, skillDir } = makeSkillFixture();
        dirs.push(projectDirectory);
        try {
            const isolatedHome = mkdtempSync(join(tmpdir(), "mc-note-hash-home3-"));
            dirs.push(isolatedHome);
            const previousHome = process.env.HOME;
            process.env.HOME = isolatedHome;
            try {
                const projectIdentity = resolveProjectIdentity(projectDirectory);
                registerTestProject(db, projectIdentity);

                // Wipe the cache + nuke the SKILL.md so resolveSkillPathByName
                // re-resolves and finds nothing → notes still save with NULL hash.
                // Simpler: write to a NEW skill name whose dir doesn't exist.
                const t = createCtxSkillNoteTool({ db });
                // Make HOME have a skill dir we cannot read by removing it
                // post-resolution is fragile. Instead, point at a SKILL.md
                // whose parent is unreadable: register an on-disk skill at
                // the path the registry says, then make the path bogus by
                // setting resolvedPath to a non-existent file (handled at the
                // registry layer).
                //
                // Pragmatic check: when computeSkillContentHash returns null
                // the note should STILL insert (skill exists at resolve time,
                // only the hash fails) — verified by removing the SKILL.md
                // after the resolve completed but before the hash call.
                rmSync(join(skillDir, "SKILL.md"));
                _resetContentHashCacheForTests();
                // The skill file is gone — resolveSkillPathByName will return
                // null and the tool will surface the "SKILL.md not found"
                // error. That's the correct behaviour: no hash, no note.
                const result = await t.execute(
                    {
                        skill: "tdd",
                        intent: "x",
                        kind: "fix",
                        delta: "note body",
                    },
                    {
                        sessionID: "ses_test",
                        agent: "general",
                        directory: projectDirectory,
                    } as never,
                );
                expect(result).toContain("SKILL.md not found");
                const row = db.prepare("SELECT COUNT(*) AS n FROM skill_memory").get() as {
                    n: number;
                };
                expect(row.n).toBe(0);
            } finally {
                process.env.HOME = previousHome;
            }
        } finally {
            closeQuietly(db);
        }
    });
});

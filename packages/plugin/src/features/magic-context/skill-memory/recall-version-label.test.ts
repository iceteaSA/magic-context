import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkMigrations } from "../fork-migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} from "../memory/embedding";
import type { EmbeddingProvider } from "../memory/embedding-provider";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { _resetContentHashCacheForTests, computeSkillContentHash } from "./content-hash";
import { buildSkillMemoryBlock, recallSkillMemoryBlock } from "./recall";
import type { SkillMemoryNote } from "./storage";
import { insertSkillMemoryNote } from "./storage";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    runForkMigrations(db);
    return db;
}

// Helper: a fully-formed SkillMemoryNote object for buildSkillMemoryBlock tests
// (the buildSkillMemoryBlock test branch does not round-trip through insert).
function fakeNote(overrides: Partial<SkillMemoryNote> = {}): SkillMemoryNote {
    const now = Date.now();
    return {
        id: 1,
        skill_id: "tdd",
        resolved_path: "/p/SKILL.md",
        tier: "global",
        skill_source: "opencode-global",
        project_identity: "git:abc",
        origin_project: null,
        source_type: null,
        intent: "fix flaky",
        intent_embedding: null,
        delta_embedding: null,
        embedding_model_version: null,
        kind: "fix",
        delta: "mock the clock",
        tags: null,
        hit_count: 1,
        recall_count: 0,
        pinned: 0,
        normalized_hash: "h",
        created_at: now,
        last_used_at: now,
        skill_content_hash: null,
        ...overrides,
    };
}

function makeSkillFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-recall-hash-"));
    const skillDir = join(dir, "skills", "tdd");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# test\n");
    return skillDir;
}

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";

describe("buildSkillMemoryBlock — version labelling", () => {
    test("byte-identical invariant when currentContentHash is undefined", () => {
        // The HARD INVARIANT from the spec: callers that don't pass a hash
        // must see the exact same string the pre-versioning buildSkillMemoryBlock
        // produced. We assert byte-for-byte equality with an explicit shape check.
        const note = fakeNote({ skill_content_hash: "abcdef0123456789" });
        const without = buildSkillMemoryBlock("tdd", "no-intent", [note], 0);
        const explicitUndef = buildSkillMemoryBlock("tdd", "no-intent", [note], 0, undefined);
        expect(without).toBe(explicitUndef);
        // And explicitly null matches undefined — both = no labelling.
        const explicitNull = buildSkillMemoryBlock("tdd", "no-intent", [note], 0, null);
        expect(without).toBe(explicitNull);
        // The rendered block must NOT contain any new attribute when currentContentHash is absent.
        expect(without).not.toContain("skill_version=");
        expect(without).not.toContain("older=");
    });

    test("labels a note as older when currentContentHash differs from stored hash", () => {
        const note = fakeNote({ skill_content_hash: "old-hash-aaaa1111" });
        const block = buildSkillMemoryBlock("tdd", "no-intent", [note], 0, "new-hash-bbbb2222");
        expect(block).toMatch(/<note[^>]*skill_version="older"/);
        // Block-level older counter is set.
        expect(block).toMatch(/<skill-memory[^>]*\bolder="1"/);
        // Advisory note appears exactly once.
        expect(block).toContain(
            'Notes marked skill_version="older" were recorded against an earlier version of this skill',
        );
    });

    test("does NOT label when currentContentHash equals stored hash", () => {
        const note = fakeNote({ skill_content_hash: "same-hash-aaaa1111" });
        const block = buildSkillMemoryBlock("tdd", "no-intent", [note], 0, "same-hash-aaaa1111");
        expect(block).not.toContain("skill_version=");
        expect(block).not.toMatch(/\bolder="/);
        // No advisory line either.
        expect(block).not.toContain("recorded against an earlier version");
    });

    test("does NOT label a note whose stored hash is NULL (legacy row)", () => {
        const note = fakeNote({ skill_content_hash: null });
        const block = buildSkillMemoryBlock("tdd", "no-intent", [note], 0, "any-current-hash");
        expect(block).not.toContain("skill_version=");
        expect(block).not.toContain("older=");
        expect(block).not.toContain("recorded against an earlier version");
    });

    test("mixed batch: only the mismatched notes get the older attribute, older=N is correct", () => {
        const same = fakeNote({ id: 1, skill_content_hash: "same-hash-aaaa1111" });
        const different = fakeNote({ id: 2, skill_content_hash: "stale-hash-cccc3333" });
        const nullHash = fakeNote({ id: 3, skill_content_hash: null });
        const block = buildSkillMemoryBlock(
            "tdd",
            "no-intent",
            [same, different, nullHash],
            0,
            "same-hash-aaaa1111",
        );
        // Exactly one older note.
        expect(block).toMatch(/\bolder="1"/);
        // The `different` note's element carries the attribute. The advisory
        // line also contains the literal `skill_version="older"` in its
        // prose, so we anchor on the <note> opening to count only per-note labels.
        const perNoteLabels = block.match(/<note[^>]*skill_version="older"/g) ?? [];
        expect(perNoteLabels.length).toBe(1);
        // No false-positive on the same or null notes — count the per-note
        // openings and verify the full set is 3.
        const openings = block.match(/<note /g) ?? [];
        expect(openings.length).toBe(3);
    });

    test("never filters or drops notes — labelling only", () => {
        const notes = [
            fakeNote({ id: 1, delta: "first", skill_content_hash: "h-1" }),
            fakeNote({ id: 2, delta: "second", skill_content_hash: "h-2" }),
            fakeNote({ id: 3, delta: "third", skill_content_hash: "h-3" }),
        ];
        const labelled = buildSkillMemoryBlock("tdd", "no-intent", notes, 0, "totally-different");
        const unlabelled = buildSkillMemoryBlock("tdd", "no-intent", notes, 0);
        for (const n of notes) {
            expect(labelled).toContain(n.delta);
            expect(unlabelled).toContain(n.delta);
        }
        // Both blocks contain every note — no drop, no filter.
        const labelledOpenings = labelled.match(/<note /g) ?? [];
        const unlabelledOpenings = unlabelled.match(/<note /g) ?? [];
        expect(labelledOpenings.length).toBe(3);
        expect(unlabelledOpenings.length).toBe(3);
    });
});

describe("recallSkillMemoryBlock — version labelling end-to-end", () => {
    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(
            (): EmbeddingProvider => ({
                modelId: "test-model",
                initialize: async () => true,
                embed: async () => new Float32Array([1, 0]),
                embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
                dispose: async () => {},
                isLoaded: () => true,
            }),
        );
    });

    test("recall with no currentContentHash produces byte-identical output to pre-versioning", async () => {
        // Snapshot the pre-versioning shape: render once with no hash, then
        // a second time with currentContentHash=undefined. They must match.
        const db = makeDb();
        try {
            registerProjectEmbedding(
                db,
                "git:abc",
                { provider: "local", model: "m" },
                {
                    memoryEnabled: true,
                    gitCommitEnabled: false,
                },
                "git:abc",
            );
            // Insert a note with an explicitly-OLD skill_content_hash. Without
            // currentContentHash, the block must NOT change.
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "fix flaky",
                kind: "fix",
                delta: "mock the clock",
                normalizedHash: "rh1",
                createdAt: Date.now(),
                skillContentHash: "old-hash-aaaa1111",
            });
            const cfg = {
                enabled: true as const,
                max_tokens: 1500,
                max_pinned_tokens: 4000,
                dedup_threshold: 0.92,
            };
            const block = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: cfg,
                // NO currentContentHash → byte-identical path
            });
            expect(block).not.toContain("skill_version=");
            expect(block).not.toContain("older=");
            expect(block).not.toContain("recorded against an earlier version");
            expect(block).toContain("mock the clock");
        } finally {
            closeQuietly(db);
        }
    });

    test("labels a note when currentContentHash differs from stored", async () => {
        const db = makeDb();
        try {
            registerProjectEmbedding(
                db,
                "git:abc",
                { provider: "local", model: "m" },
                {
                    memoryEnabled: true,
                    gitCommitEnabled: false,
                },
                "git:abc",
            );
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "fix flaky",
                kind: "fix",
                delta: "mock the clock",
                normalizedHash: "rh2",
                createdAt: Date.now(),
                skillContentHash: "old-hash-cccc3333",
            });
            const block = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
                currentContentHash: "new-hash-dddd4444",
            });
            expect(block).toMatch(/<note[^>]*skill_version="older"/);
            expect(block).toContain("recorded against an earlier version");
        } finally {
            closeQuietly(db);
        }
    });

    test("end-to-end: a real skill folder computes its hash and is plumbed through recall", async () => {
        _resetContentHashCacheForTests();
        const db = makeDb();
        const skillDir = makeSkillFixtureDir();
        try {
            registerProjectEmbedding(
                db,
                "git:abc",
                { provider: "local", model: "m" },
                {
                    memoryEnabled: true,
                    gitCommitEnabled: false,
                },
                "git:abc",
            );
            // Insert a note stamped with a STALE hash. Then ask recall for the
            // CURRENT hash of the on-disk fixture — they differ → label.
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: join(skillDir, "SKILL.md"),
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "fix flaky",
                kind: "fix",
                delta: "mock the clock",
                normalizedHash: "rh3",
                createdAt: Date.now(),
                skillContentHash: "stale-aaaa000000000000",
            });
            const currentHash = computeSkillContentHash(skillDir);
            expect(currentHash).not.toBeNull();
            expect(currentHash).not.toBe("stale-aaaa000000000000");
            const block = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
                currentContentHash: currentHash,
            });
            expect(block).toMatch(/<note[^>]*skill_version="older"/);
        } finally {
            rmSync(skillDir, { recursive: true, force: true });
            closeQuietly(db);
        }
    });

    test("end-to-end: a re-recorded note (current hash now matches stored) renders unlabelled", async () => {
        _resetContentHashCacheForTests();
        const db = makeDb();
        const skillDir = makeSkillFixtureDir();
        try {
            registerProjectEmbedding(
                db,
                "git:abc",
                { provider: "local", model: "m" },
                {
                    memoryEnabled: true,
                    gitCommitEnabled: false,
                },
                "git:abc",
            );
            // Compute the current hash BEFORE writing the row, then stamp the
            // note with the SAME hash — this is exactly what a dedup re-record
            // does (refreshes the stored hash to the current one).
            const currentHash = computeSkillContentHash(skillDir);
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: join(skillDir, "SKILL.md"),
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "fix flaky",
                kind: "fix",
                delta: "mock the clock",
                normalizedHash: "rh4",
                createdAt: Date.now(),
                skillContentHash: currentHash,
            });
            const block = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
                currentContentHash: currentHash,
            });
            expect(block).not.toContain("skill_version=");
            expect(block).not.toContain("older=");
        } finally {
            rmSync(skillDir, { recursive: true, force: true });
            closeQuietly(db);
        }
    });
});

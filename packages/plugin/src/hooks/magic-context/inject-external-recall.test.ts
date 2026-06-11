/// <reference types="bun-types" />

// Render integration for the external-recall snapshot (Tasks 6).
//
// Invariants this test guards:
//   1. A "done" snapshot already persisted before materializeM0 is baked INTO
//      m[0] as a sibling <external-memory> block (project + global slices).
//   2. Profile slice lines merge INTO <user-profile>, NOT into the external block.
//   3. No snapshot → no <external-memory> block, marker externalRecallHash is "".
//   4. Late arrival (snapshot lands AFTER m[0] is materialized) routes to the
//      m[1] <external-memory> delta on the next cache-busting pass; m[0] does
//      NOT rematerialize (mustMaterialize stays false).
//   5. After a HARD fold (next materialize), the delta disappears and the
//      snapshot is fully baked into m[0].
//   6. Recalled items get NO fake <memory id=…> markup — plain "- content" lines.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    type M0HardSignals,
    type M0M1RenderOptions,
    type M0M1State,
    materializeM0,
    mustMaterialize,
    renderM1,
} from "./inject-compartments";

const SESSION_ID = "ses_ext_recall";
const PROJECT_PATH = "/tmp/test-ext-recall-project";
const PROJECT_DIRECTORY = "/tmp/test-ext-recall-project-dir";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    // v31 (external recall columns) is required so seedRecallSnapshot can
    // UPDATE the recall columns. Without migrations, readExternalRecallSnapshot
    // catches the missing-column error and behaves as "never started".
    runMigrations(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-ext-recall-test-"));
    tempDirs.push(dir);
    return dir;
}

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    toolSetHash: "tools-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

function seedRecallSnapshot(
    dbInstance: Database,
    sessionId: string,
    snapshot: {
        project?: Array<{ content: string; category?: string }>;
        profile?: Array<{ content: string; category?: string }>;
        global?: Array<{ content: string; category?: string }>;
    },
): void {
    dbInstance
        .prepare(
            "UPDATE session_meta SET external_recall_state = ?, external_recall_json = ?, external_recall_at = ? WHERE session_id = ?",
        )
        .run("done", JSON.stringify(snapshot), Date.now(), sessionId);
}

function buildOptions(): M0M1RenderOptions {
    return {
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
        projectPath: PROJECT_PATH,
        projectDirectory: PROJECT_DIRECTORY,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: true,
        hardSignals: BASE_HARD,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("external recall in m[0]/m[1]", () => {
    test("done snapshot before first materialize bakes <external-memory> into m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "ext proj fact" }],
            profile: [{ content: "ext user pref" }],
            global: [{ content: "ext homelab fact" }],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        // project + global slices in <external-memory>
        expect(result.m0Text).toContain('<external-memory source="hindsight">');
        expect(result.m0Text).toContain("- ext proj fact");
        expect(result.m0Text).toContain("- ext homelab fact");
        // profile merges into <user-profile>, NOT into the external block
        const userProfileStart = result.m0Text.indexOf("<user-profile>");
        const userProfileEnd = result.m0Text.indexOf("</user-profile>");
        expect(userProfileStart).toBeGreaterThanOrEqual(0);
        expect(userProfileEnd).toBeGreaterThan(userProfileStart);
        const userProfileSection = result.m0Text.slice(userProfileStart, userProfileEnd);
        expect(userProfileSection).toContain("- ext user pref");
        const externalBlockStart = result.m0Text.indexOf("<external-memory");
        const externalBlockEnd = result.m0Text.indexOf("</external-memory>");
        const externalBlockSection = result.m0Text.slice(externalBlockStart, externalBlockEnd);
        expect(externalBlockSection).not.toContain("ext user pref");
        // no fake <memory id=…> markup for recalled items
        expect(result.m0Text).not.toMatch(/<memory[^>]*id="[^"]*"[^>]*>ext (proj|homelab|user) /);
        // marker is set
        expect(result.snapshotMarkers.externalRecallHash).not.toBe("");
    });

    test("no snapshot → no external block, marker empty", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        expect(result.m0Text).not.toContain("<external-memory");
        expect(result.snapshotMarkers.externalRecallHash).toBe("");
    });

    test("late arrival: snapshot lands after materialize → m[1] delta, no m[0] rematerialize", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // First materialize with no snapshot.
        const first = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        expect(first.m0Text).not.toContain("<external-memory");
        expect(first.snapshotMarkers.externalRecallHash).toBe("");

        // Snapshot lands AFTER m[0] is materialized. The fact that recall is
        // now "done" must NOT bust m[0] (mustMaterialize stays false).
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "late fact" }],
            profile: [],
            global: [],
        });
        // Mirror the production decision flow: re-hydrate state from the DB
        // and ask mustMaterialize.
        const stateForDecision = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state: stateForDecision,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: BASE_HARD,
        });
        // Settled recall alone does NOT flip mustMaterialize — late recall rides m[1].
        expect(decision.value).toBe(false);

        // The m[1] delta on the next soft-refresh carries the late snapshot.
        const m1 = renderM1(buildOptions(), first.snapshotMarkers, first.renderedMemoryIds);
        expect(m1).toContain("<external-memory");
        expect(m1).toContain("- late fact");
    });

    test("HARD fold reconciles: after re-materialize, delta disappears", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "late fact" }],
            profile: [],
            global: [],
        });
        const second = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        // Now baked into m[0] AND no longer in the m[1] delta (the
        // markers.externalRecallHash matches the persisted hash).
        expect(second.m0Text).toContain("- late fact");
        const m1 = renderM1(buildOptions(), second.snapshotMarkers, second.renderedMemoryIds);
        expect(m1).not.toContain("<external-memory");
    });

    test("snapshot block renders AFTER <project-memory>", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Seed a memory so <project-memory> exists in the render.
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "local fact",
            importance: 50,
            sourceType: "historian",
        });
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "ext proj fact" }],
            profile: [],
            global: [{ content: "ext homelab fact" }],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        const projectMemoryIdx = result.m0Text.indexOf("<project-memory>");
        const externalIdx = result.m0Text.indexOf("<external-memory");
        expect(projectMemoryIdx).toBeGreaterThanOrEqual(0);
        expect(externalIdx).toBeGreaterThan(projectMemoryIdx);
    });
});

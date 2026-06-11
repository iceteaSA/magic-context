import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DREAMER_AGENT } from "../../agents/dreamer";
import {
    getMemoriesByProject,
    getMemoryById,
    getMemoryMutationsForRender,
    getProjectState,
    insertMemory,
    normalizeStoredProjectPath,
} from "../../features/magic-context";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    initializeExternalMemory,
} from "../../features/magic-context/memory/external-memory";
import type {
    ExternalMemoryBackend,
    ExternalMemoryRemoveItem,
    ExternalMemoryRetainItem,
} from "../../features/magic-context/memory/external-memory-provider";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (_text: string) => null,
    isEmbeddingEnabled: () => true,
    getEmbeddingModelId: () => "mock:model",
}));

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE IF NOT EXISTS memories
        (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path            TEXT    NOT NULL,
            category                TEXT    NOT NULL,
            content                 TEXT    NOT NULL,
            normalized_hash         TEXT    NOT NULL,
            source_session_id       TEXT,
            source_type             TEXT    DEFAULT 'historian',
            seen_count              INTEGER DEFAULT 1,
            retrieval_count         INTEGER DEFAULT 0,
            first_seen_at           INTEGER NOT NULL,
            created_at              INTEGER NOT NULL,
            updated_at              INTEGER NOT NULL,
            last_seen_at            INTEGER NOT NULL,
            last_retrieved_at       INTEGER,
            status                  TEXT    DEFAULT 'active',
            expires_at              INTEGER,
            verification_status     TEXT    DEFAULT 'unverified',
            verified_at             INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from             TEXT,
            metadata_json           TEXT,
            UNIQUE (project_path, category, normalized_hash)
        );

        CREATE TABLE IF NOT EXISTS memory_embeddings
        (
            memory_id INTEGER PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id  TEXT
        );

        CREATE TABLE IF NOT EXISTS project_state
        (
            project_path                 TEXT PRIMARY KEY,
            project_memory_epoch         INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at                   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_mutation_log
        (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path     TEXT NOT NULL,
            mutation_type    TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL,
            superseded_by_id INTEGER,
            category         TEXT,
            new_content      TEXT,
            queued_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
            ON memory_mutation_log(project_path, id);

        CREATE
        VIRTUAL
        TABLE IF
        NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;
    `);
    return db;
}

const toolContext = (sessionID = "ses-memory", agent = "general") =>
    ({ sessionID, agent, directory: "/repo/project" }) as never;

function getProjectMemoryEpoch(db: Database, projectPath: string): number {
    return getProjectState(db, normalizeStoredProjectPath(projectPath))?.projectMemoryEpoch ?? 0;
}

function getMutationRows(db: Database, projectPath: string, renderedMemoryIds: number[]) {
    return getMemoryMutationsForRender(
        db,
        normalizeStoredProjectPath(projectPath),
        0,
        renderedMemoryIds,
    );
}

const HINDSIGHT_TEST_CONFIG = {
    provider: "hindsight" as const,
    endpoint: "http://10.0.0.1:8889",
    project_bank: "mc-{name}-{id8}",
    main_bank: "main-memory",
    retain_sources: ["historian", "agent", "dreamer"] as ("historian" | "agent" | "dreamer")[],
    tags: [] as string[],
    recall: {
        enabled: true,
        timeout_ms: 3000,
        max_tokens: 2048,
        dedup_threshold: 0.85,
        global_tags: [] as string[],
        search: true,
        mental_models: false,
        profile_mental_models: ["user-preferences"],
    },
};

interface ExternalBackendCapture {
    retains: ExternalMemoryRetainItem[][];
    removes: ExternalMemoryRemoveItem[][];
}

function captureBackend(): ExternalBackendCapture {
    const capture: ExternalBackendCapture = { retains: [], removes: [] };
    _setTestExternalBackendFactory(
        (): ExternalMemoryBackend => ({
            backendId: "fake:test",
            initialize: async () => true,
            retain: async (items) => {
                capture.retains.push([...items]);
                return items.length;
            },
            remove: async (items) => {
                capture.removes.push([...items]);
                return items.length;
            },
            dispose: async () => {},
        }),
    );
    initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
    return capture;
}

function captureTee(): ExternalMemoryRetainItem[][] {
    return captureBackend().retains;
}

afterAll(() => {
    mock.restore();
});

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        });
    });

    afterEach(() => {
        closeQuietly(db);
        _resetExternalMemoryForTests();
    });

    describe("#given write action", () => {
        it("creates a new memory with agent source type", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Always run bun test before shipping.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(result).toContain("Saved memory [ID:");
            expect(memories).toHaveLength(1);
            expect(memories[0]?.sourceType).toBe("agent");
            expect(memories[0]?.sourceSessionId).toBe("ses-memory");
            expect(memories[0]?.category).toBe("USER_DIRECTIVES");
        });

        it("does not bump project memory epoch for additive writes", async () => {
            const identity = normalizeStoredProjectPath("/repo/project");

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Prefer compact diffs.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            expect(getProjectState(db, identity)).toBeNull();
        });

        it("returns error when content is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'content' is required");
        });

        it("returns error when category is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'category' is required");
        });

        it("returns error for unknown category", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "UNKNOWN_CATEGORY",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("Unknown memory category");
        });

        it("always uses project scope for writes", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_PREFERENCES",
                    content: "Keep answers dense.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories).toHaveLength(1);
            expect(memories[0]?.projectPath).toBe("/repo/project");
        });

        it("tees to external backend with project scope", async () => {
            const calls = captureTee();

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "agent fact",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            await Bun.sleep(10);

            expect(calls.length).toBe(1);
            expect(calls[0]?.[0]).toMatchObject({
                content: "agent fact",
                category: "ARCHITECTURE",
                scope: "project",
                sourceType: expect.any(String),
            });
        });

        it("does NOT tee when memory already exists", async () => {
            const calls = captureTee();

            await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "dup",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "dup",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );
            await Bun.sleep(10);

            expect(calls.length).toBe(1);
        });
    });

    describe("#given delete action", () => {
        it("archives the memory by ID", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser fails on malformed XML.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "delete", id: memory.id },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expect(result).toContain("Archived memory");
            expect(updated?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "delete", targetMemoryId: memory.id },
            ]);
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "delete" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'id' is required");
        });

        it("returns error when memory not found", async () => {
            const result = await tools.ctx_memory.execute(
                { action: "delete", id: 999 },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("was not found");
        });
    });

    describe("#given list action", () => {
        it("returns a formatted memory table", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before shipping.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Do not use npm in this repo.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "list", limit: 10 },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Found 2 active memories");
            expect(result).toContain("CATEGORY");
            expect(result).toContain("Always run bun test before shipping.");
            expect(result).toContain("Do not use npm in this repo.");
        });
    });

    describe("#given update action", () => {
        it("updates memory content and invalidates stale embeddings", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    id: memory.id,
                    content: "cache_ttl=10m",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=10m");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                {
                    mutationType: "update",
                    targetMemoryId: memory.id,
                    category: "CONFIG_DEFAULTS",
                    newContent: "cache_ttl=10m",
                },
            ]);
        });

        it("normalizes legacy raw project paths before queueing the mutation", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    id: memory.id,
                    content: "timeout=10s",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getProjectState(db, projectIdentity)).toBeNull();
            expect(getProjectState(db, rawProjectPath)).toBeNull();
            expect(getMutationRows(db, projectIdentity, [memory.id])).toMatchObject([
                { mutationType: "update", targetMemoryId: memory.id, newContent: "timeout=10s" },
            ]);
        });

        it("rolls back content updates when queueing the mutation fails", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.exec("DROP TABLE memory_mutation_log");

            let thrown: unknown;
            try {
                await tools.ctx_memory.execute(
                    {
                        action: "update",
                        id: memory.id,
                        content: "cache_ttl=10m",
                    },
                    toolContext("ses-dreamer", DREAMER_AGENT),
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("memory_mutation_log");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });
    });

    describe("#given merge action", () => {
        it("creates a canonical merged memory and archives source memories", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts in this repo",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            const activeMemories = getMemoriesByProject(db, "/repo/project");
            expect(activeMemories).toHaveLength(1);
            expect(activeMemories[0]?.content).toBe("Use bun for all scripts in this repository.");
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [first.id, second.id])).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: first.id,
                    supersededById: activeMemories[0]?.id,
                },
                {
                    mutationType: "superseded",
                    targetMemoryId: second.id,
                    supersededById: activeMemories[0]?.id,
                },
            ]);
        });

        it("queues an update row when an existing canonical memory content changes", async () => {
            const canonical = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const duplicate = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [canonical.id, duplicate.id],
                    content: "USE BUN FOR SCRIPTS",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`canonical memory [ID: ${canonical.id}]`);
            expect(getMemoryById(db, canonical.id)?.content).toBe("USE BUN FOR SCRIPTS");
            expect(
                getMutationRows(db, "/repo/project", [canonical.id, duplicate.id]),
            ).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: duplicate.id,
                    supersededById: canonical.id,
                },
                {
                    mutationType: "update",
                    targetMemoryId: canonical.id,
                    newContent: "USE BUN FOR SCRIPTS",
                },
            ]);
        });

        it("queues superseded rows under each affected project identity when merging across identities", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            const third = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id, third.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            expect(getProjectMemoryEpoch(db, "/repo/project-a")).toBe(0);
            expect(getProjectMemoryEpoch(db, "/repo/project-b")).toBe(0);
            expect(getMutationRows(db, "/repo/project-a", [first.id, second.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: first.id },
                { mutationType: "superseded", targetMemoryId: second.id },
            ]);
            expect(getMutationRows(db, "/repo/project-b", [third.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: third.id },
            ]);
        });
    });

    describe("#given archive action", () => {
        it("archives the memory and stores the archive reason in metadata", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Old issue entry",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    id: memory.id,
                    reason: "Removed subsystem no longer exists",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Archived memory");
            expect(getMemoryById(db, memory.id)?.metadataJson).toContain(
                "Removed subsystem no longer exists",
            );
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "archive", targetMemoryId: memory.id },
            ]);
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "delete", id: 1 }, toolContext()),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });

    describe("#given restricted actions", () => {
        it("keeps dreamer actions in the schema so OpenCode can deliver them to execute", () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: ["write", "delete"],
            });

            const actionSchema = primaryTools.ctx_memory.args.action as unknown as {
                safeParse: (value: unknown) => { success: boolean };
            };

            expect(actionSchema.safeParse("list").success).toBe(true);
            expect(actionSchema.safeParse("merge").success).toBe(true);
        });

        it("rejects dreamer-only actions for primary-agent tool instances", async () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: ["write", "delete"],
            });

            const result = await primaryTools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("not allowed");
        });

        it("allows dreamer sessions to use dreamer-only actions on the shared tool", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep replies concise.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: ["write", "delete"],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });

    describe("#given corrective propagation to external backend", () => {
        function extractMemoryId(result: string): number {
            const match = result.match(/\[ID:\s*(\d+)\]/);
            if (!match) throw new Error(`could not parse memory id from: ${result}`);
            return Number.parseInt(match[1]!, 10);
        }

        it("delete action propagates remove to external backend", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "ARCHITECTURE",
                    content: "doomed fact",
                },
                toolContext(),
            );
            const id = extractMemoryId(writeResult);

            const deleteResult = await tools.ctx_memory.execute(
                { action: "delete", id },
                toolContext(),
            );

            expect(deleteResult).toContain("Archived memory");
            // The write tees a retain (fire-and-forget); the corrective delete must
            // also tee a remove with the same content + project scope.
            await Bun.sleep(10);
            expect(capture.removes.length).toBe(1);
            expect(capture.removes[0]?.[0]).toMatchObject({
                content: "doomed fact",
                category: "ARCHITECTURE",
                scope: "project",
            });
            // Sanity: the write's retain is still in the log too.
            expect(capture.retains.length).toBe(1);
        });

        it("archive action propagates remove to external backend", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "PROJECT_RULES",
                    content: "stale fact",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);

            const archiveResult = await tools.ctx_memory.execute(
                { action: "archive", id, reason: "subsystem removed" },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(archiveResult).toContain("Archived memory");
            await Bun.sleep(10);
            expect(capture.removes.length).toBe(1);
            expect(capture.removes[0]?.[0]?.content).toBe("stale fact");
            expect(capture.removes[0]?.[0]?.category).toBe("PROJECT_RULES");
        });

        it("update action removes old content and tees new content", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "CONFIG_VALUES",
                    content: "old wording",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);
            // Wait for the write's retain to land before counting subsequent calls.
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const updateResult = await tools.ctx_memory.execute(
                {
                    action: "update",
                    id,
                    content: "new wording",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(updateResult).toContain("Updated memory");
            await Bun.sleep(10);
            // Old content removed from external (the document identity derives
            // from the original content hash; without the remove, the new retain
            // would create a duplicate document).
            expect(capture.removes.length).toBe(1);
            expect(capture.removes[0]?.[0]?.content).toBe("old wording");
            // Corrected content teed as a new document.
            const teed = capture.retains.flat();
            expect(teed.some((item) => item.content === "new wording")).toBe(true);
        });

        it("verify action sets verification status and upserts verbatim", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "PROJECT_RULES",
                    content: "true fact",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const verifyResult = await tools.ctx_memory.execute(
                { action: "verify", id },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(verifyResult).toContain("Verified memory");
            // The local row's verification_status flipped.
            expect(getMemoryById(db, id)?.verificationStatus).toBe("verified");
            await Bun.sleep(10);
            // Verbatim re-retain = same document_id = server-side upsert — the
            // single retain should contain the EXACT unchanged content plus
            // verifiedAt metadata. No remove is fired (the document is current).
            const upserted = capture.retains.flat();
            expect(upserted.length).toBe(1);
            expect(upserted[0]?.content).toBe("true fact");
            expect(typeof upserted[0]?.verifiedAt).toBe("number");
            expect(capture.removes.length).toBe(0);
        });

        it("merge does NOT propagate to external backend (canonical rewrite is local-only)", async () => {
            const capture = captureBackend();
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "use bun",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "use bun for everything",
            });
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const mergeResult = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "use bun for all the things",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(mergeResult).toContain("Merged memories");
            await Bun.sleep(10);
            // Merge is a local canonical rewrite — no external retain, no remove.
            // v1 rule: the canonical document was never externally re-teed.
            expect(capture.removes.length).toBe(0);
            expect(capture.retains.length).toBe(0);
        });

        it("verify rejects non-dreamer agents", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "primary-only memory",
            });

            // Primary agent tool with default allowedActions = ["write","delete"].
            // "verify" is a dreamer-only action and the action is not in
            // allowedActions → rejected with the "not allowed" error.
            const result = await tools.ctx_memory.execute(
                { action: "verify", id: 1 },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("not allowed");
        });
    });
});

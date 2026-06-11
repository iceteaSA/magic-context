import { afterEach, describe, expect, test } from "bun:test";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    getExternalRecallConfig,
    initializeExternalMemory,
    isExternalSearchEnabled,
    recallFromExternalBackend,
    removeFromExternalBackend,
    teeToExternalBackend,
    upsertToExternalBackend,
} from "./external-memory";
import type {
    ExternalMemoryBackend,
    ExternalMemoryRecallQuery,
    ExternalMemoryRecallResult,
    ExternalMemoryRemoveItem,
    ExternalMemoryRetainItem,
} from "./external-memory-provider";

function makeFakeBackend(calls: ExternalMemoryRetainItem[][]): ExternalMemoryBackend {
    return {
        backendId: "fake:test",
        initialize: async () => true,
        retain: async (items) => {
            calls.push([...items]);
            return items.length;
        },
        dispose: async () => {},
    };
}

const HINDSIGHT_TEST_CONFIG = {
    provider: "hindsight" as const,
    endpoint: "http://10.1.1.1:8889",
    project_bank: "mc-{name}-{id8}",
    main_bank: "icetea-main",
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

const item: ExternalMemoryRetainItem = {
    content: "Use bun test for all packages",
    category: "PROJECT_RULES",
    scope: "project",
    projectIdentity: "git:abcdef1234567890",
    projectName: "magic-context",
    sourceType: "historian",
    sessionId: "ses_1",
};

afterEach(() => _resetExternalMemoryForTests());

describe("teeToExternalBackend", () => {
    test("no-op when provider off", async () => {
        const calls: ExternalMemoryRetainItem[][] = [];
        _setTestExternalBackendFactory(() => makeFakeBackend(calls));
        initializeExternalMemory({ provider: "off" });
        await teeToExternalBackend("historian", [item]);
        expect(calls.length).toBe(0);
    });

    test("retains when provider configured and source allowed", async () => {
        const calls: ExternalMemoryRetainItem[][] = [];
        _setTestExternalBackendFactory(() => makeFakeBackend(calls));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        await teeToExternalBackend("historian", [item]);
        expect(calls.length).toBe(1);
        expect(calls[0][0].content).toBe(item.content);
    });

    test("filters by retain_sources", async () => {
        const calls: ExternalMemoryRetainItem[][] = [];
        _setTestExternalBackendFactory(() => makeFakeBackend(calls));
        initializeExternalMemory({ ...HINDSIGHT_TEST_CONFIG, retain_sources: ["historian"] });
        await teeToExternalBackend("agent", [item]);
        expect(calls.length).toBe(0);
    });

    test("never throws when backend retain rejects", async () => {
        _setTestExternalBackendFactory(() => ({
            backendId: "fake:boom",
            initialize: async () => true,
            retain: async () => {
                throw new Error("boom");
            },
            dispose: async () => {},
        }));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        await expect(teeToExternalBackend("historian", [item])).resolves.toBeUndefined();
    });

    test("empty items is a no-op", async () => {
        const calls: ExternalMemoryRetainItem[][] = [];
        _setTestExternalBackendFactory(() => makeFakeBackend(calls));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        await teeToExternalBackend("historian", []);
        expect(calls.length).toBe(0);
    });

    test("config change re-creates backend; same identity keeps it", async () => {
        let created = 0;
        const calls: ExternalMemoryRetainItem[][] = [];
        _setTestExternalBackendFactory(() => {
            created += 1;
            return makeFakeBackend(calls);
        });
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        await teeToExternalBackend("historian", [item]);
        // same identity → backend kept
        initializeExternalMemory({ ...HINDSIGHT_TEST_CONFIG, retain_sources: ["historian"] });
        await teeToExternalBackend("historian", [item]);
        expect(created).toBe(1);
        // different endpoint → re-created
        initializeExternalMemory({ ...HINDSIGHT_TEST_CONFIG, endpoint: "http://10.1.1.2:8889" });
        await teeToExternalBackend("historian", [item]);
        expect(created).toBe(2);
    });
});

function makeRecallBackend(captured: {
    recalls: ExternalMemoryRecallQuery[];
    removes: ExternalMemoryRemoveItem[][];
    retains: ExternalMemoryRetainItem[][];
}): ExternalMemoryBackend {
    return {
        backendId: "fake:recall",
        initialize: async () => true,
        retain: async (items) => {
            captured.retains.push([...items]);
            return items.length;
        },
        recall: async (query) => {
            captured.recalls.push(query);
            return [{ content: "ext fact", category: "ARCHITECTURE" }];
        },
        remove: async (items) => {
            captured.removes.push([...items]);
            return items.length;
        },
        dispose: async () => {},
    };
}

describe("ungated v2 orchestrator paths", () => {
    test("recallFromExternalBackend returns results when provider on", async () => {
        const captured = {
            recalls: [],
            removes: [],
            retains: [],
        } as Parameters<typeof makeRecallBackend>[0];
        _setTestExternalBackendFactory(() => makeRecallBackend(captured));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        const results = await recallFromExternalBackend({ query: "q", scope: "project" });
        expect(results).toEqual([{ content: "ext fact", category: "ARCHITECTURE" }]);
        expect(captured.recalls.length).toBe(1);
    });

    test("recallFromExternalBackend returns [] when provider off", async () => {
        initializeExternalMemory({ provider: "off" });
        expect(await recallFromExternalBackend({ query: "q" })).toEqual([]);
    });

    test("recallFromExternalBackend never throws", async () => {
        _setTestExternalBackendFactory(() => ({
            backendId: "fake:boom",
            initialize: async () => true,
            retain: async () => 0,
            recall: async () => {
                throw new Error("boom");
            },
            dispose: async () => {},
        }));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        await expect(recallFromExternalBackend({ query: "q" })).resolves.toEqual([]);
    });

    test("removeFromExternalBackend ignores retain_sources filter", async () => {
        const captured = {
            recalls: [],
            removes: [],
            retains: [],
        } as Parameters<typeof makeRecallBackend>[0];
        _setTestExternalBackendFactory(() => makeRecallBackend(captured));
        initializeExternalMemory({ ...HINDSIGHT_TEST_CONFIG, retain_sources: [] });
        await removeFromExternalBackend([
            { content: "x", category: "PROJECT_RULES", scope: "project", projectIdentity: "git:a" },
        ]);
        expect(captured.removes.length).toBe(1);
    });

    test("upsertToExternalBackend ignores retain_sources filter", async () => {
        const captured = {
            recalls: [],
            removes: [],
            retains: [],
        } as Parameters<typeof makeRecallBackend>[0];
        _setTestExternalBackendFactory(() => makeRecallBackend(captured));
        initializeExternalMemory({ ...HINDSIGHT_TEST_CONFIG, retain_sources: [] });
        await upsertToExternalBackend([
            {
                content: "x",
                category: "PROJECT_RULES",
                scope: "project",
                projectIdentity: "git:a",
                sourceType: "dreamer",
                verifiedAt: 123,
            },
        ]);
        expect(captured.retains.length).toBe(1);
        expect(captured.retains[0][0].verifiedAt).toBe(123);
    });

    test("getExternalRecallConfig reflects provider state", () => {
        initializeExternalMemory({ provider: "off" });
        expect(getExternalRecallConfig()).toBeNull();
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        expect(getExternalRecallConfig()?.enabled).toBe(true);
        expect(isExternalSearchEnabled()).toBe(true);
    });
});

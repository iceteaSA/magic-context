import { afterEach, describe, expect, test } from "bun:test";
import type { ExternalMemoryBackend, ExternalMemoryRetainItem } from "./external-memory-provider";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    initializeExternalMemory,
    teeToExternalBackend,
} from "./external-memory";

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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HindsightMemoryBackend } from "./external-memory-hindsight";
import type { ExternalMemoryRetainItem } from "./external-memory-provider";
import { computeNormalizedHash } from "./normalize-hash";

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit }> = [];
let responder: (url: string) => Response;

function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
    requests = [];
    responder = (url) => {
        if (url.endsWith("/v1/default/banks")) {
            return okJson({ banks: [{ bank_id: "main-memory" }] });
        }
        if (/\/banks\/[^/]+$/.test(url)) return okJson({ bank_id: "x" });
        return okJson({ success: true, bank_id: "b", items_count: 1, async: true });
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init: init ?? {} });
        return responder(url);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

function makeBackend(): HindsightMemoryBackend {
    return new HindsightMemoryBackend({
        provider: "hindsight",
        endpoint: "http://10.0.0.1:8889",
        api_key: "tok-123",
        project_bank: "mc-{name}-{id8}",
        main_bank: "main-memory",
        retain_sources: ["historian", "agent", "dreamer"],
        tags: ["user:test"],
    });
}

const projectItem: ExternalMemoryRetainItem = {
    content: "Always run bun test from packages/plugin",
    category: "PROJECT_RULES",
    scope: "project",
    projectIdentity: "git:abcdef1234567890",
    projectName: "magic-context",
    sourceType: "historian",
    sessionId: "ses_1",
};
const userItem: ExternalMemoryRetainItem = {
    content: "User prefers terse answers",
    category: "USER_PROFILE",
    scope: "user",
    sourceType: "dreamer",
};

describe("HindsightMemoryBackend", () => {
    test("routes project items to templated bank and creates it once", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([projectItem]);
        expect(accepted).toBe(1);
        const puts = requests.filter((r) => r.init.method === "PUT");
        expect(puts.length).toBe(1);
        expect(puts[0].url).toContain("/v1/default/banks/mc-magic-context-abcdef12");
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts[0].url).toContain("/v1/default/banks/mc-magic-context-abcdef12/memories");
        requests = [];
        await backend.retain([projectItem]);
        expect(requests.filter((r) => r.init.method === "PUT").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "GET").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "POST").length).toBe(1);
    });

    test("routes user items to main bank without ensure-create", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([userItem]);
        expect(accepted).toBe(1);
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts.length).toBe(1);
        expect(posts[0].url).toContain("/v1/default/banks/main-memory/memories");
        expect(requests.filter((r) => r.init.method === "PUT").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "GET").length).toBe(0);
    });

    test("payload shape: verbatim content, document_id, tags, async, auth", async () => {
        const backend = makeBackend();
        await backend.retain([projectItem]);
        const post = requests.find((r) => r.init.method === "POST");
        if (!post) throw new Error("no retain POST");
        const headers = post.init.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer tok-123");
        const body = JSON.parse(String(post.init.body));
        expect(body.async).toBe(true);
        const item = body.items[0];
        expect(item.content).toBe(projectItem.content);
        expect(item.document_id).toBe(
            `mc:git:abcdef1234567890:PROJECT_RULES:${computeNormalizedHash(projectItem.content)}`,
        );
        expect(item.context).toContain("magic-context");
        expect(item.metadata.category).toBe("PROJECT_RULES");
        expect(item.metadata.session_id).toBe("ses_1");
        expect(item.tags).toContain("source:magic-context");
        expect(item.tags).toContain("category:PROJECT_RULES");
        expect(item.tags).toContain("project:git:abcdef1234567890");
        expect(item.tags).toContain("project-name:magic-context");
        expect(item.tags).toContain("user:test");
        expect(item.tags).not.toContain("scope:project");
    });

    test("user item tags carry scope:user and no project tags", async () => {
        const backend = makeBackend();
        await backend.retain([userItem]);
        const post = requests.find((r) => r.init.method === "POST");
        const body = JSON.parse(String(post?.init.body));
        expect(body.items[0].tags).toContain("scope:user");
        expect(body.items[0].tags.some((t: string) => t.startsWith("project:"))).toBe(false);
        expect(body.items[0].document_id).toBe(
            `mc:user:USER_PROFILE:${computeNormalizedHash(userItem.content)}`,
        );
    });

    test("mixed batch groups by bank", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([projectItem, userItem]);
        expect(accepted).toBe(2);
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts.length).toBe(2);
        const urls = posts.map((p) => p.url).join(" ");
        expect(urls).toContain("mc-magic-context-abcdef12/memories");
        expect(urls).toContain("main-memory/memories");
    });

    test("422 logs and does not throw, retry, or open circuit", async () => {
        responder = () => new Response("rejected", { status: 422 });
        const backend = makeBackend();
        const accepted = await backend.retain([userItem]);
        expect(accepted).toBe(0);
        expect(requests.filter((r) => r.init.method === "POST").length).toBe(1);
        expect(backend._getCircuitState()).toBe("closed");
    });

    test("never throws on network error", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeBackend();
        await expect(backend.retain([userItem])).resolves.toBe(0);
    });

    test("circuit opens after repeated failures and short-circuits", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeBackend();
        await backend.retain([userItem]);
        await backend.retain([userItem]);
        await backend.retain([userItem]);
        expect(backend._getCircuitState()).toBe("open");
    });

    test("initialize fails without endpoint", async () => {
        const backend = new HindsightMemoryBackend({
            provider: "hindsight",
            endpoint: "",
            project_bank: "mc-{name}-{id8}",
            main_bank: "main-memory",
            retain_sources: ["historian", "agent", "dreamer"],
            tags: [],
        });
        expect(await backend.initialize()).toBe(false);
        expect(await backend.retain([userItem])).toBe(0);
    });
});

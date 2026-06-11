import { describe, expect, test } from "bun:test";
import { MagicContextConfigSchema } from "./magic-context";

describe("MagicContextConfigSchema memory.external.recall", () => {
    test("recall sub-block defaults when omitted", () => {
        const config = MagicContextConfigSchema.parse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.1.1.1:8889",
                    main_bank: "icetea-main",
                },
            },
        });
        const external = config.memory.external;
        if (external.provider !== "hindsight") throw new Error("expected hindsight");
        expect(external.recall).toEqual({
            enabled: true,
            timeout_ms: 3000,
            max_tokens: 2048,
            dedup_threshold: 0.85,
            global_tags: [],
            search: true,
            mental_models: true,
            profile_mental_models: ["user-preferences"],
        });
    });

    test("recall sub-block bounds enforced", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.1.1.1:8889",
                    main_bank: "icetea-main",
                    recall: { timeout_ms: 100, dedup_threshold: 1.5 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("provider off ignores recall block", () => {
        const config = MagicContextConfigSchema.parse({
            memory: { external: { provider: "off", recall: { enabled: true } } },
        });
        expect(config.memory.external).toEqual({ provider: "off" });
    });
});

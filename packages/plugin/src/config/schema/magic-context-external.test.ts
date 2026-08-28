import { describe, expect, test } from "bun:test";
import { MagicContextConfigSchema } from "./magic-context";

describe("MagicContextConfigSchema memory.external.search", () => {
    test("retains only the explicit ctx_search switch", () => {
        const config = MagicContextConfigSchema.parse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                },
            },
        });
        const external = config.memory.external;
        if (external.provider !== "hindsight") throw new Error("expected hindsight");
        expect(external.search).toBe(true);
    });

    test("drops unknown nested settings", () => {
        const config = MagicContextConfigSchema.parse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    legacy_session_option: true,
                },
            },
        });
        const external = config.memory.external;
        if (external.provider !== "hindsight") throw new Error("expected hindsight");
        expect(external.search).toBe(true);
    });

    test("provider off ignores recall block", () => {
        const config = MagicContextConfigSchema.parse({
            memory: { external: { provider: "off", search: true } },
        });
        expect(config.memory.external).toEqual({ provider: "off" });
    });
});

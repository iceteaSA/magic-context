/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    composeToolExecuteBeforeHooks,
    containsDroppedInputPlaceholder,
    createDroppedInputToolExecuteBeforeHook,
} from "./dropped-input-guard";

const blockedInputs: Array<[string, unknown]> = [
    ["tagged drop sentinel", { command: "[dropped §431§]" }],
    ["legacy five-character truncation", { command: "which...[truncated]" }],
    ["legacy array summary", { files: "[3 items]" }],
    ["legacy object summary", { metadata: "[object]" }],
    ["new dropped marker object", { dropped: "[dropped §431§]" }],
];

describe("dropped input execution guard", () => {
    for (const [label, input] of blockedInputs) {
        it(`detects the ${label}`, () => {
            expect(containsDroppedInputPlaceholder(input)).toBe(true);
        });
    }

    it("walks nested input without mistaking explanatory prose for a placeholder", () => {
        expect(
            containsDroppedInputPlaceholder({ nested: [{ value: "abcde...[truncated]" }] }),
        ).toBe(true);
        expect(
            containsDroppedInputPlaceholder({
                content: "The log used ...[truncated] before the final retry.",
            }),
        ).toBe(false);
        // A real value that ends with the sentinel text is longer than any copied
        // placeholder (five characters plus the sentinel) and must stay executable.
        expect(
            containsDroppedInputPlaceholder({
                content: "expected output line 1\nexpected output line 2\n...[truncated]",
            }),
        ).toBe(false);
    });

    it("rejects through the OpenCode tool.execute.before hook with recovery guidance", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();

        await expect(
            hook(
                { tool: "write", sessionID: "ses-431", callID: "call-431" },
                { args: { filePath: "/tmp/...[truncated]", content: "payload" } },
            ),
        ).rejects.toThrow("ctx_expand");
    });

    it("allows ordinary executable arguments", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        await expect(
            hook(
                { tool: "bash", sessionID: "ses-clean", callID: "call-clean" },
                { args: { command: "which docker" } },
            ),
        ).resolves.toBeUndefined();
    });
});

// OpenCode exposes ONE `tool.execute.before` key, but this plugin has two
// independent duties for it (this guard, and skill-memory intent capture).
// Registering both as object keys silently drops one; they are composed instead.
// TS1117 catches the duplicate-key form at compile time — these lock the
// composed runtime contract: every handler runs, in order, and a throw aborts
// the rest so a guard's rejection pre-empts later side effects.
describe("composeToolExecuteBeforeHooks", () => {
    it("runs every handler in registration order", async () => {
        const order: string[] = [];
        await composeToolExecuteBeforeHooks(
            async () => {
                order.push("first");
            },
            async () => {
                order.push("second");
            },
        )({ tool: "skill" }, { args: {} });
        expect(order).toEqual(["first", "second"]);
    });

    it("aborts on the first throw so later handlers never observe rejected input", async () => {
        const reached: string[] = [];
        const composed = composeToolExecuteBeforeHooks(
            createDroppedInputToolExecuteBeforeHook(),
            async () => {
                reached.push("after-guard");
            },
        );
        await expect(
            composed({ tool: "bash" }, { args: { command: "[dropped §431§]" } }),
        ).rejects.toThrow();
        expect(reached).toEqual([]);
    });

    it("passes the same input and output references to each handler", async () => {
        const seen: Array<[unknown, unknown]> = [];
        const input = { tool: "skill", callID: "call_1" };
        const output = { args: { name: "council" } };
        await composeToolExecuteBeforeHooks(
            async (i, o) => {
                seen.push([i, o]);
            },
            async (i, o) => {
                seen.push([i, o]);
            },
        )(input, output);
        expect(seen).toEqual([
            [input, output],
            [input, output],
        ]);
    });
});

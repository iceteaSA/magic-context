// The pre-fix truncated render kept at most five characters of the original
// value before the sentinel, so a copied placeholder always has that exact
// shape. Matching only that shape keeps a legitimate value that merely ends
// with the sentinel text (a log line, a fixture) executable.
const LEGACY_TRUNCATED_VALUE = /^[\s\S]{0,5}\.\.\.\[truncated\]$/;
const DROPPED_INPUT_MESSAGE =
    "A tool argument was a dropped placeholder and was not executed. Recover the original arguments with ctx_expand, then issue a fresh tool call.";

function isDroppedPlaceholderString(value: string): boolean {
    return (
        (value.startsWith("[dropped §") && value.endsWith("§]")) ||
        LEGACY_TRUNCATED_VALUE.test(value) ||
        value === "[object]" ||
        /^\[\d+ items\]$/.test(value)
    );
}

export function droppedInputMarker(tagId: number): { dropped: string } {
    return { dropped: `[dropped §${tagId}§]` };
}

export function containsDroppedInputPlaceholder(value: unknown): boolean {
    const seen = new WeakSet<object>();

    const visit = (candidate: unknown): boolean => {
        if (typeof candidate === "string") return isDroppedPlaceholderString(candidate);
        if (candidate === null || typeof candidate !== "object") return false;
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        if (Array.isArray(candidate)) return candidate.some(visit);
        return Object.values(candidate as Record<string, unknown>).some(visit);
    };

    return visit(value);
}

export function assertExecutableToolInput(input: unknown): void {
    if (containsDroppedInputPlaceholder(input)) {
        throw new Error(DROPPED_INPUT_MESSAGE);
    }
}

export function createDroppedInputToolExecuteBeforeHook() {
    return async (_input: unknown, output: unknown): Promise<void> => {
        const args =
            output !== null && typeof output === "object"
                ? (output as { args?: unknown }).args
                : undefined;
        assertExecutableToolInput(args);
    };
}

/**
 * Run several `tool.execute.before` handlers under the single hook key OpenCode
 * exposes. Handlers run in order and are NOT isolated from each other: the first
 * to throw aborts the rest, which is the intended contract for guard handlers
 * (a guard's rejection must pre-empt later side effects).
 */
export function composeToolExecuteBeforeHooks(
    ...handlers: ReadonlyArray<(input: unknown, output: unknown) => unknown | Promise<unknown>>
) {
    return async (input: unknown, output: unknown): Promise<void> => {
        for (const handler of handlers) await handler(input, output);
    };
}

export { DROPPED_INPUT_MESSAGE };

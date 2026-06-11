import type {
    ExternalMemoryConfig,
    ExternalMemoryRetainSource,
} from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { HindsightMemoryBackend } from "./external-memory-hindsight";
import type { ExternalMemoryBackend, ExternalMemoryRetainItem } from "./external-memory-provider";

const OFF_CONFIG: ExternalMemoryConfig = { provider: "off" };

let externalConfig: ExternalMemoryConfig = OFF_CONFIG;
let backend: ExternalMemoryBackend | null = null;
let testBackendFactory: ((config: ExternalMemoryConfig) => ExternalMemoryBackend | null) | null =
    null;

export function createExternalMemoryBackend(
    config: ExternalMemoryConfig,
): ExternalMemoryBackend | null {
    if (testBackendFactory) {
        return config.provider === "off" ? null : testBackendFactory(config);
    }
    if (config.provider === "hindsight") {
        return new HindsightMemoryBackend(config);
    }
    return null;
}

function configIdentity(config: ExternalMemoryConfig): string {
    if (config.provider === "off") return "external-memory:off";
    return `external-memory:${config.provider}:${config.endpoint}:${config.main_bank}:${config.project_bank}`;
}

export function initializeExternalMemory(config?: ExternalMemoryConfig): void {
    const next = config ?? OFF_CONFIG;
    if (configIdentity(next) === configIdentity(externalConfig)) {
        externalConfig = next; // pick up retain_sources/tags changes cheaply
        return;
    }
    const previous = backend;
    externalConfig = next;
    backend = null;
    if (previous) {
        void previous.dispose().catch((error) => {
            log("[magic-context] external memory backend dispose failed:", error);
        });
    }
}

function getOrCreateBackend(): ExternalMemoryBackend | null {
    if (backend) return backend;
    backend = createExternalMemoryBackend(externalConfig);
    return backend;
}

/**
 * Fire-and-forget tee of memory creations to the external backend.
 * Best-effort: NEVER throws, never blocks the caller's local write.
 * `source` identifies the creation point for retain_sources filtering.
 */
export async function teeToExternalBackend(
    source: ExternalMemoryRetainSource,
    items: ExternalMemoryRetainItem[],
): Promise<void> {
    try {
        if (items.length === 0) return;
        if (externalConfig.provider === "off") return;
        if (!externalConfig.retain_sources.includes(source)) return;
        const current = getOrCreateBackend();
        if (!current) return;
        if (!(await current.initialize())) return;
        const accepted = await current.retain(items);
        if (accepted > 0) {
            log(`[magic-context] external memory: retained ${accepted}/${items.length} item(s)`);
        }
    } catch (error) {
        log("[magic-context] external memory tee failed:", error);
    }
}

export async function disposeExternalMemoryBackend(): Promise<void> {
    const current = backend;
    backend = null;
    if (current) await current.dispose();
}

// Test-only hooks (mirror embedding.ts naming).
export function _setTestExternalBackendFactory(
    factory: ((config: ExternalMemoryConfig) => ExternalMemoryBackend | null) | null,
): void {
    testBackendFactory = factory;
}
export function _resetExternalMemoryForTests(): void {
    externalConfig = OFF_CONFIG;
    backend = null;
    testBackendFactory = null;
}

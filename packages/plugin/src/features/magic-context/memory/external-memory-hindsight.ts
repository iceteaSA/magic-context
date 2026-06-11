import type { ExternalMemoryConfig } from "../../../config/schema/magic-context";
import type { ExternalMemoryBackend, ExternalMemoryRetainItem } from "./external-memory-provider";

type HindsightConfig = Extract<ExternalMemoryConfig, { provider: "hindsight" }>;

/** Stub — full implementation lands in the next task. */
export class HindsightMemoryBackend implements ExternalMemoryBackend {
    readonly backendId: string;

    constructor(config: HindsightConfig) {
        this.backendId = `hindsight:${config.endpoint}:${config.main_bank}:${config.project_bank}`;
    }

    async initialize(): Promise<boolean> {
        return false;
    }

    async retain(_items: ExternalMemoryRetainItem[]): Promise<number> {
        return 0;
    }

    async dispose(): Promise<void> {}
}

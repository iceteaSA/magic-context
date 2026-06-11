import type { MemoryCategory, MemorySourceType } from "./types";

/** "project" = tied to a project identity. "user" = user-level (dreamer user
 *  memories). "global" = neither — automatic fallback scope (nothing emits it
 *  in v1; reserved for corrective retains / session streams). */
export type ExternalMemoryScope = "project" | "user" | "global";

export interface ExternalMemoryRetainItem {
    content: string;
    /** MemoryCategory or the pseudo-category "USER_PROFILE" (user memories). */
    category: MemoryCategory | "USER_PROFILE";
    /** "project" items carry projectIdentity/projectName; "user"/"global" carry neither. */
    scope: ExternalMemoryScope;
    /** resolveProjectIdentity() result — "git:<sha>" or "dir:<md5-12>". */
    projectIdentity?: string;
    /** Human-readable basename — secondary label only, never a key. */
    projectName?: string;
    sourceType: MemorySourceType;
    sessionId?: string;
}

/** v2 neutral recall shapes — defined now so the slot is stable, unused in v1. */
export interface ExternalMemoryRecallQuery {
    query: string;
    scope?: ExternalMemoryScope;
    projectIdentity?: string;
    limit?: number;
}
export interface ExternalMemoryRecallResult {
    content: string;
    score?: number;
    category?: string;
}

export interface ExternalMemoryBackend {
    /** Identity string (provider + endpoint + banks) — drives singleton
     *  re-creation on config change, like EmbeddingProvider.modelId. */
    readonly backendId: string;
    initialize(): Promise<boolean>;
    /** Best-effort batch retain. Never throws; returns count accepted. */
    retain(items: ExternalMemoryRetainItem[], signal?: AbortSignal): Promise<number>;
    /** v2 slot — unified read path. Optional; unimplemented in v1. */
    recall?(
        query: ExternalMemoryRecallQuery,
        signal?: AbortSignal,
    ): Promise<ExternalMemoryRecallResult[]>;
    dispose(): Promise<void>;
}

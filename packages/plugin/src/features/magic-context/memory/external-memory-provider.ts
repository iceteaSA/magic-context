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
    /** Set on verify-confirmed corrective upserts — maps to engine metadata. */
    verifiedAt?: number;
}

/** v2 neutral recall shapes — engine maps scope to its own partitions/filters. */
export interface ExternalMemoryRecallQuery {
    query: string;
    scope?: ExternalMemoryScope;
    projectIdentity?: string;
    /** Needed by bank-template resolution for scope "project". */
    projectName?: string;
    limit?: number;
    maxTokens?: number;
}
export interface ExternalMemoryRecallResult {
    content: string;
    score?: number;
    category?: string;
}

/** Corrective removal — document identity derives from the ORIGINAL content. */
export interface ExternalMemoryRemoveItem {
    content: string;
    category: MemoryCategory | "USER_PROFILE";
    scope: ExternalMemoryScope;
    projectIdentity?: string;
    projectName?: string;
}

export interface ExternalMemoryBackend {
    /** Identity string (provider + endpoint + banks) — drives singleton
     *  re-creation on config change, like EmbeddingProvider.modelId. */
    readonly backendId: string;
    initialize(): Promise<boolean>;
    /** Best-effort batch retain. Never throws; returns count accepted. */
    retain(items: ExternalMemoryRetainItem[], signal?: AbortSignal): Promise<number>;
    /** v2 unified read. Never throws; [] on failure. */
    recall?(
        query: ExternalMemoryRecallQuery,
        signal?: AbortSignal,
    ): Promise<ExternalMemoryRecallResult[]>;
    /** v2 corrective removal. Never throws; returns count removed (404 counts: already gone). */
    remove?(items: ExternalMemoryRemoveItem[], signal?: AbortSignal): Promise<number>;
    dispose(): Promise<void>;
}

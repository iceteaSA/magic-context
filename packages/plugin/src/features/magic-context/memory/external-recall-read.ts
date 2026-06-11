import { createHash } from "node:crypto";
import type { Database } from "../../../shared/sqlite";

export interface ExternalRecallSliceItem {
    content: string;
    category?: string;
}
export interface ExternalRecallSnapshot {
    project: ExternalRecallSliceItem[];
    profile: ExternalRecallSliceItem[];
    global: ExternalRecallSliceItem[];
}
export type ExternalRecallState = "pending" | "done" | "failed";

export function isSnapshotEmpty(snapshot: ExternalRecallSnapshot): boolean {
    return (
        snapshot.project.length === 0 &&
        snapshot.profile.length === 0 &&
        snapshot.global.length === 0
    );
}

/** Deterministic fingerprint of a snapshot; '' for empty/none. */
export function computeRecallSnapshotHash(snapshot: ExternalRecallSnapshot | null): string {
    if (!snapshot || isSnapshotEmpty(snapshot)) return "";
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
}

export function readExternalRecallSnapshot(
    db: Database,
    sessionId: string,
): { state: ExternalRecallState | null; snapshot: ExternalRecallSnapshot | null } {
    let row: { state?: unknown; json?: unknown } | null = null;
    try {
        row = db
            .prepare(
                "SELECT external_recall_state AS state, external_recall_json AS json FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { state?: unknown; json?: unknown } | null;
    } catch {
        return { state: null, snapshot: null }; // pre-migration DB — behave as never-started
    }
    const state =
        row?.state === "pending" || row?.state === "done" || row?.state === "failed"
            ? row.state
            : null;
    if (state !== "done" || typeof row?.json !== "string" || row.json.length === 0) {
        return { state, snapshot: null };
    }
    try {
        const parsed = JSON.parse(row.json) as Partial<ExternalRecallSnapshot>;
        return {
            state,
            snapshot: {
                project: Array.isArray(parsed.project) ? parsed.project : [],
                profile: Array.isArray(parsed.profile) ? parsed.profile : [],
                global: Array.isArray(parsed.global) ? parsed.global : [],
            },
        };
    } catch {
        return { state, snapshot: null };
    }
}

/** Marker-capture helper: hash of the persisted DONE snapshot, '' otherwise. */
export function readExternalRecallHash(db: Database, sessionId: string): string {
    const { state, snapshot } = readExternalRecallSnapshot(db, sessionId);
    if (state !== "done") return "";
    return computeRecallSnapshotHash(snapshot);
}

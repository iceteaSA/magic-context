import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Total bytes the hasher is willing to read per folder before it falls back to
 * the truncated form. Past the cap, the hash includes a stable marker so two
 * runs over the same oversize folder produce identical output rather than
 * depending on read order — the goal is to detect CHANGE, not to fingerprint
 * a megabyte of files.
 */
const MAX_BYTES_READ = 4 * 1024 * 1024;
const TRUNCATED_MARKER = Buffer.from("\0<magic-context:truncated>\0", "utf-8");

interface CacheEntry {
    hash: string;
    maxMtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

interface WalkEntry {
    absPath: string;
    relPath: string;
}

/**
 * Recursively walk `dir`, returning regular files in deterministic order, with
 * dotfiles and node_modules excluded. Symlinks are NOT followed (a symlink loop
 * in a vendor copy of node_modules would otherwise pin the read). On any
 * filesystem error returns null and writes nothing to the cache.
 */
function walkFiles(dir: string): WalkEntry[] | null {
    const out: WalkEntry[] = [];
    const stack: string[] = [dir];
    try {
        while (stack.length > 0) {
            const current = stack.pop() as string;
            const entries = readdirSync(current, { withFileTypes: true });
            // Sort by name for deterministic DFS order; the per-entry hashing
            // step ALSO sorts by relative path, so traversal order is a
            // belt-and-suspenders defense against readdir() randomness.
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue;
                if (entry.name === "node_modules") continue;
                const absPath = join(current, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    stack.push(absPath);
                    continue;
                }
                if (!entry.isFile()) continue;
                const relPath = absPath.slice(dir.length + 1);
                out.push({ absPath, relPath });
            }
        }
    } catch {
        return null;
    }
    out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return out;
}

/**
 * Compute a stable, content-derived hash for a skill folder. Same files in →
 * same hash out, regardless of mtime, ctime, or creation order. Renaming a
 * file or flipping a byte flips the hash. Dotfiles and node_modules are
 * skipped (real SKILL.md trees ship neither, but we do not want a stray
 * `.DS_Store` to bust every recall).
 *
 * Returns the first 16 hex chars of a SHA-256 over `relpath\0content\0` for
 * each regular file in sorted-by-relpath order, with a truncation marker
 * appended when the folder exceeds the byte cap. Returns null when the
 * folder is unreadable or does not exist. Never throws — the cache stores
 * null-failures so a hot path does not retry a known-broken folder.
 */
export function computeSkillContentHash(skillDir: string): string | null {
    const cached = cache.get(skillDir);
    if (cached) {
        // Re-stat to check whether anything changed under us; the cache key is
        // a cheap mtime-max snapshot. A single statSync per call beats holding
        // a filesystem watcher for what is otherwise a low-volume path.
        let currentMax = 0;
        try {
            const files = walkFiles(skillDir);
            if (!files) {
                return null;
            }
            for (const f of files) {
                const st = statSync(f.absPath);
                if (st.mtimeMs > currentMax) currentMax = st.mtimeMs;
            }
        } catch {
            return null;
        }
        if (currentMax === cached.maxMtimeMs) return cached.hash;
        // else fall through to recompute
        cache.delete(skillDir);
    }

    const files = walkFiles(skillDir);
    if (!files) return null;

    const hasher = createHash("sha256");
    let bytesRead = 0;
    let truncated = false;
    let maxMtimeMs = 0;
    try {
        for (const f of files) {
            const st = statSync(f.absPath);
            if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
            const remaining = MAX_BYTES_READ - bytesRead;
            if (remaining <= 0) {
                truncated = true;
                break;
            }
            let content: Buffer;
            try {
                content = readFileSync(f.absPath);
            } catch {
                // Unreadable file (perm denied / race) → treat as empty so the
                // hash still covers the rest of the folder deterministically;
                // better an "as-if zero-length" hash than a runtime throw on
                // every recall.
                content = Buffer.alloc(0);
            }
            // relpath\0 prefix, then content, then a content-side \0 separator
            // before the NEXT relpath (the joining \0 below). Same content
            // concatenated differently would otherwise hash identically.
            hasher.update(f.relPath);
            hasher.update("\0");
            if (content.length <= remaining) {
                hasher.update(content);
                bytesRead += content.length;
            } else {
                hasher.update(content.subarray(0, remaining));
                bytesRead = MAX_BYTES_READ;
                truncated = true;
                break;
            }
            hasher.update("\0");
        }
    } catch {
        return null;
    }

    if (truncated) {
        hasher.update(TRUNCATED_MARKER);
    }

    const full = hasher.digest("hex");
    const hash = full.slice(0, 16);
    cache.set(skillDir, { hash, maxMtimeMs });
    return hash;
}

/**
 * Test-only escape hatch — drop every cached entry. The recall path is read-only
 * on disk, but the mtime-check cache could mask a regression where an edit
 * should bust the hash; the tests need a clean slate between scenarios.
 */
export function _resetContentHashCacheForTests(): void {
    cache.clear();
}

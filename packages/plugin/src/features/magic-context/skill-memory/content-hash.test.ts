import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetContentHashCacheForTests, computeSkillContentHash } from "./content-hash";

// Determinism across runs: the cache reads mtime and would otherwise re-stat
// on every test. _resetContentHashCacheForTests is called in beforeEach.
function makeSkillDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkillFile(dir: string, relPath: string, content: string): void {
    const abs = join(dir, relPath);
    const parent = abs.substring(0, abs.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content);
}

describe("computeSkillContentHash", () => {
    const tempDirs: string[] = [];

    beforeEach(() => {
        _resetContentHashCacheForTests();
    });

    afterEach(() => {
        for (const d of tempDirs.splice(0)) {
            try {
                rmSync(d, { recursive: true, force: true });
            } catch {
                // best-effort scratch cleanup
            }
        }
    });

    function fixtureDir(prefix: string): string {
        const d = makeSkillDir(prefix);
        tempDirs.push(d);
        return d;
    }

    test("identical content in two dirs produces the same hash", () => {
        const a = fixtureDir("hash-same-a-");
        const b = fixtureDir("hash-same-b-");
        writeSkillFile(a, "SKILL.md", "# hello\n");
        writeSkillFile(b, "SKILL.md", "# hello\n");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).not.toBeNull();
        expect(hb).not.toBeNull();
        expect(ha).toBe(hb);
    });

    test("changing one byte flips the hash", () => {
        const a = fixtureDir("hash-byte-a-");
        const b = fixtureDir("hash-byte-b-");
        writeSkillFile(a, "SKILL.md", "# hello world\n");
        writeSkillFile(b, "SKILL.md", "# hello WORLD\n");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).not.toBeNull();
        expect(hb).not.toBeNull();
        expect(ha).not.toBe(hb);
    });

    test("renaming a file changes the hash (path is part of the digest)", () => {
        const a = fixtureDir("hash-rename-a-");
        const b = fixtureDir("hash-rename-b-");
        writeSkillFile(a, "SKILL.md", "same content");
        writeSkillFile(b, "OTHER.md", "same content");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).not.toBeNull();
        expect(hb).not.toBeNull();
        expect(ha).not.toBe(hb);
    });

    test("mtime or creation order alone does NOT change the hash", () => {
        const a = fixtureDir("hash-mtime-a-");
        const b = fixtureDir("hash-mtime-b-");
        writeSkillFile(a, "SKILL.md", "content a\n");
        writeSkillFile(a, "extra.md", "content b\n");
        writeSkillFile(b, "SKILL.md", "content a\n");
        writeSkillFile(b, "extra.md", "content b\n");

        // Push mtimes way back and way forward on each side, out of natural order.
        const farPast = new Date(2000, 0, 1);
        const farFuture = new Date(2100, 0, 1);
        utimesSync(join(a, "SKILL.md"), farFuture, farFuture);
        utimesSync(join(a, "extra.md"), farPast, farPast);
        utimesSync(join(b, "SKILL.md"), farPast, farPast);
        utimesSync(join(b, "extra.md"), farFuture, farFuture);

        // Cache key depends on max mtime; reset it before reading so the
        // comparison exercises the content path, not the cache.
        _resetContentHashCacheForTests();
        const ha = computeSkillContentHash(a);
        _resetContentHashCacheForTests();
        const hb = computeSkillContentHash(b);
        expect(ha).toBe(hb);
    });

    test("dotfiles are ignored", () => {
        const a = fixtureDir("hash-dot-a-");
        const b = fixtureDir("hash-dot-b-");
        writeSkillFile(a, "SKILL.md", "visible content\n");
        writeSkillFile(a, ".DS_Store", "mac noise noise noise\n");
        writeSkillFile(b, "SKILL.md", "visible content\n");
        writeSkillFile(b, ".env", "SECRET=value\n");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).toBe(hb);
    });

    test("dot-dirs are ignored (their contents are excluded)", () => {
        const a = fixtureDir("hash-dotdir-a-");
        const b = fixtureDir("hash-dotdir-b-");
        writeSkillFile(a, "SKILL.md", "visible content\n");
        writeSkillFile(a, ".git/HEAD", "ref: refs/heads/main\n");
        writeSkillFile(b, "SKILL.md", "visible content\n");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).toBe(hb);
    });

    test("node_modules is ignored", () => {
        const a = fixtureDir("hash-nm-a-");
        const b = fixtureDir("hash-nm-b-");
        writeSkillFile(a, "SKILL.md", "skill content\n");
        writeSkillFile(a, "node_modules/dep/index.js", "ignored body A\n");
        writeSkillFile(b, "SKILL.md", "skill content\n");
        writeSkillFile(b, "node_modules/dep/index.js", "ignored body B\n");
        const ha = computeSkillContentHash(a);
        const hb = computeSkillContentHash(b);
        expect(ha).toBe(hb);
    });

    test("unreadable directory returns null (no throw)", () => {
        // chmod 0 hides the dir from the OS — opens fail. computeSkillContentHash
        // must not throw and must return null so callers can degrade gracefully.
        const d = fixtureDir("hash-unreadable-");
        writeSkillFile(d, "SKILL.md", "x\n");
        chmodSync(d, 0o000);
        try {
            expect(computeSkillContentHash(d)).toBeNull();
        } finally {
            // Restore perms so rmSync can clean up.
            chmodSync(d, 0o755);
        }
    });

    test("non-existent directory returns null (no throw)", () => {
        const missing = join(tmpdir(), "definitely-not-here-xyz-12345");
        expect(existsSync(missing)).toBe(false);
        expect(computeSkillContentHash(missing)).toBeNull();
    });

    test("result is exactly 16 hex chars", () => {
        const a = fixtureDir("hash-len-");
        writeSkillFile(a, "SKILL.md", "x\n");
        const h = computeSkillContentHash(a);
        expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    test("mtime-bumping an unchanged file invalidates the cache (read returns current)", () => {
        // Cache should NOT pin stale results. Bump mtime without changing
        // content; the next computeSkillContentHash MUST still return the
        // same hash (content unchanged) but the path must have re-read.
        const d = fixtureDir("hash-cache-");
        writeSkillFile(d, "SKILL.md", "stable\n");
        const first = computeSkillContentHash(d);
        // Force the mtime far enough in the future that the cache entry
        // is invalidated on next read.
        utimesSync(join(d, "SKILL.md"), new Date(2100, 0, 1), new Date(2100, 0, 1));
        const second = computeSkillContentHash(d);
        expect(first).toBe(second); // content unchanged → same hash
    });
});

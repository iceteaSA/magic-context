import type { ExternalMemoryConfig } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { blockedEmbeddingEndpointReason } from "./embedding-ssrf";
import type { ExternalMemoryBackend, ExternalMemoryRetainItem } from "./external-memory-provider";
import { computeNormalizedHash } from "./normalize-hash";

type HindsightConfig = Extract<ExternalMemoryConfig, { provider: "hindsight" }>;

// Circuit breaker constants — same shape as embedding-openai.ts so a hung
// Hindsight endpoint can't drag every plugin operation through its timeout.
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

type CircuitState = "closed" | "open" | "half_open";

const RETAIN_CONTEXT =
    "magic-context curated fact store (structured project/user memory, not conversation)";
const PROJECT_BANK_MISSION =
    "Curated long-term memory for one software project, fed by the magic-context plugin: " +
    "project rules, architecture decisions, configuration values, constraints, and naming " +
    "conventions extracted from coding sessions. Facts are pre-deduplicated and pre-curated; " +
    "extract them faithfully without speculation.";

function sanitizeBankSegment(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "project"
    );
}

export class HindsightMemoryBackend implements ExternalMemoryBackend {
    readonly backendId: string;

    private readonly endpoint: string;
    private readonly apiKey: string;
    private readonly projectBankTemplate: string;
    private readonly mainBank: string;
    private readonly staticTags: readonly string[];
    private initialized = false;
    private readonly ensuredBanks = new Set<string>();

    // Circuit breaker state — copied from OpenAICompatibleEmbeddingProvider.
    private failureTimes: number[] = [];
    private circuitOpenUntil = 0;
    private openLogged = false;
    private halfOpenProbeInFlight = false;

    constructor(config: HindsightConfig) {
        this.endpoint = config.endpoint.replace(/\/+$/, "");
        this.apiKey = config.api_key ?? "";
        this.projectBankTemplate = config.project_bank;
        this.mainBank = config.main_bank;
        this.staticTags = config.tags;
        this.backendId = `hindsight:${this.endpoint}:${this.mainBank}:${this.projectBankTemplate}`;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.mainBank) {
            log("[magic-context] hindsight backend missing endpoint or main_bank");
            return false;
        }
        const blockedReason = blockedEmbeddingEndpointReason(this.endpoint);
        if (blockedReason) {
            log(`[magic-context] hindsight endpoint blocked: ${blockedReason}`);
            return false;
        }
        this.initialized = true;
        return true;
    }

    resolveBank(item: ExternalMemoryRetainItem): string {
        if (item.scope === "project" && item.projectIdentity) {
            const id8 = item.projectIdentity.replace(/^(git:|dir:)/, "").slice(0, 8);
            const name = sanitizeBankSegment(item.projectName ?? "project");
            return this.projectBankTemplate.replace("{name}", name).replace("{id8}", id8);
        }
        return this.mainBank;
    }

    buildMemoryItem(item: ExternalMemoryRetainItem): Record<string, unknown> {
        const scopeKey =
            item.scope === "project" ? (item.projectIdentity ?? "project") : item.scope;
        const scopeTags =
            item.scope === "project" && item.projectIdentity
                ? [
                      `project:${item.projectIdentity}`,
                      ...(item.projectName ? [`project-name:${item.projectName}`] : []),
                  ]
                : [`scope:${item.scope}`];
        return {
            content: item.content,
            context: RETAIN_CONTEXT,
            document_id: `mc:${scopeKey}:${item.category}:${computeNormalizedHash(item.content)}`,
            metadata: {
                source: "magic-context",
                category: item.category,
                ...(item.projectIdentity ? { project_path: item.projectIdentity } : {}),
                ...(item.sessionId ? { session_id: item.sessionId } : {}),
            },
            tags: [
                "source:magic-context",
                `category:${item.category}`,
                ...scopeTags,
                ...this.staticTags,
            ],
        };
    }

    async retain(items: ExternalMemoryRetainItem[], signal?: AbortSignal): Promise<number> {
        if (items.length === 0) return 0;
        if (!(await this.initialize())) return 0;
        const byBank = new Map<string, ExternalMemoryRetainItem[]>();
        for (const item of items) {
            const bank = this.resolveBank(item);
            const group = byBank.get(bank);
            if (group) group.push(item);
            else byBank.set(bank, [item]);
        }
        let accepted = 0;
        for (const [bank, group] of byBank) {
            try {
                if (!(await this.ensureBank(bank, signal))) continue;
                const ok = await this.postRetain(bank, group, signal);
                if (ok) accepted += group.length;
            } catch (error) {
                log(`[magic-context] hindsight retain failed for bank ${bank}:`, error);
            }
        }
        return accepted;
    }

    private async ensureBank(bank: string, signal?: AbortSignal): Promise<boolean> {
        if (bank === this.mainBank) return true;
        if (this.ensuredBanks.has(bank)) return true;
        const listResponse = await this.request("GET", "/v1/default/banks", undefined, signal);
        if (!listResponse) return false;
        const listBody = (await listResponse.json().catch(() => null)) as {
            banks?: Array<{ bank_id?: string }>;
        } | null;
        const exists = (listBody?.banks ?? []).some((b) => b.bank_id === bank);
        if (!exists) {
            const created = await this.request(
                "PUT",
                `/v1/default/banks/${encodeURIComponent(bank)}`,
                { name: bank, mission: PROJECT_BANK_MISSION },
                signal,
            );
            if (!created) return false;
        }
        this.ensuredBanks.add(bank);
        return true;
    }

    private async postRetain(
        bank: string,
        group: ExternalMemoryRetainItem[],
        signal?: AbortSignal,
    ): Promise<boolean> {
        const response = await this.request(
            "POST",
            `/v1/default/banks/${encodeURIComponent(bank)}/memories`,
            { items: group.map((item) => this.buildMemoryItem(item)), async: true },
            signal,
        );
        if (!response) return false;
        const body = (await response.json().catch(() => null)) as { success?: boolean } | null;
        return body?.success === true;
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
        signal?: AbortSignal,
    ): Promise<Response | null> {
        if (signal?.aborted) return null;
        let isProbe = false;
        let internalController: AbortController | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let onOuterAbort: (() => void) | undefined;
        try {
            const claim = this.claimProbeOrShortCircuit();
            if (claim === "short_circuit") return null;
            isProbe = claim === "probe";
            internalController = new AbortController();
            timeoutHandle = setTimeout(() => internalController?.abort(), FETCH_TIMEOUT_MS);
            onOuterAbort = () => internalController?.abort();
            if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });

            const response = await fetch(`${this.endpoint}${path}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                redirect: "error",
                signal: internalController.signal,
            });

            if (response.status === 422) {
                log(
                    `[magic-context] hindsight memory defense rejected content (${method} ${path}) — not retrying`,
                );
                this.recordSuccess();
                return null;
            }
            if (!response.ok) {
                log(
                    `[magic-context] hindsight request failed: ${method} ${path} → ${response.status} ${response.statusText}`,
                );
                this.recordFailure(isProbe);
                return null;
            }
            this.recordSuccess();
            return response;
        } catch (error) {
            const isAbort =
                error instanceof Error &&
                (error.name === "AbortError" || error.message.includes("aborted"));
            if (isAbort && signal?.aborted) {
                // Caller gave up — don't penalize the endpoint.
            } else {
                log(`[magic-context] hindsight request error: ${method} ${path}:`, error);
                this.recordFailure(isProbe);
            }
            return null;
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            if (signal && onOuterAbort) signal.removeEventListener("abort", onOuterAbort);
            if (isProbe) this.halfOpenProbeInFlight = false;
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
        this.ensuredBanks.clear();
    }

    // ── Circuit breaker — copied verbatim from OpenAICompatibleEmbeddingProvider
    // (embedding-openai.ts lines 291-372) with log prefixes "openai-compatible
    // embedding" → "hindsight". Same three-state machine, same rolling window,
    // same probe-claim semantics. Documented in embedding-openai.ts.

    private claimProbeOrShortCircuit(): "allow" | "probe" | "short_circuit" {
        if (this.circuitOpenUntil === 0) {
            return "allow";
        }
        if (Date.now() < this.circuitOpenUntil) {
            return "short_circuit";
        }
        if (this.halfOpenProbeInFlight) {
            return "short_circuit";
        }
        this.halfOpenProbeInFlight = true;
        log("[magic-context] hindsight: circuit half-open, probing endpoint");
        return "probe";
    }

    private recordFailure(isProbe: boolean): void {
        if (isProbe) {
            this.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] hindsight: probe failed, re-opening circuit for ${OPEN_DURATION_MS / 60_000}min`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
            return;
        }

        const now = Date.now();
        const cutoff = now - FAILURE_WINDOW_MS;
        this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
        this.failureTimes.push(now);

        if (this.failureTimes.length >= FAILURE_THRESHOLD) {
            this.circuitOpenUntil = now + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] hindsight: opening circuit for ${OPEN_DURATION_MS / 60_000}min after ${this.failureTimes.length} failures in ${FAILURE_WINDOW_MS / 1_000}s`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
        }
    }

    private recordSuccess(): void {
        if (this.failureTimes.length > 0 || this.circuitOpenUntil > 0 || this.openLogged) {
            log("[magic-context] hindsight: endpoint recovered, circuit closed");
        }
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
    }

    _getCircuitState(): CircuitState {
        if (this.circuitOpenUntil === 0) return "closed";
        if (Date.now() < this.circuitOpenUntil) {
            return this.halfOpenProbeInFlight ? "half_open" : "open";
        }
        return "half_open";
    }
    _getFailureCount(): number {
        return this.failureTimes.length;
    }
    _resetCircuit(): void {
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.halfOpenProbeInFlight = false;
    }
}

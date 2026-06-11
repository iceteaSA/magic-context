import { DREAMER_AGENT } from "../../agents/dreamer";
import { HISTORIAN_AGENT } from "../../agents/historian";
import {
    isDreamerRunnable,
    isHistorianRunnable,
    isSidekickRunnable,
} from "../../config/agent-disable";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
    type DreamerConfig,
    type HistorianConfig,
    type SidekickConfig,
} from "../../config/schema/magic-context";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    checkScheduleAndEnqueue,
    processDreamQueue,
    registerDreamProjectDirectory,
} from "../../features/magic-context/dreamer";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    getSessionsWithPendingMarker,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import { getCurrentToolSetHash } from "../../features/magic-context/tool-definition-tokens";
import type { ContextUsage } from "../../features/magic-context/types";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { resolveFallbackChain } from "../../shared/resolve-fallbacks";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { deriveHistorianChunkTokens, resolveHistorianContextLimit } from "./derive-budgets";
import { createEventHandler } from "./event-handler";
import { resolveContextLimit, resolveModelKey } from "./event-resolvers";
import { clearInjectionCache } from "./inject-compartments";
import { createNudger } from "./nudger";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import { runManagedRecomp, runManagedUpgrade } from "./recomp-orchestrator";
import { createTextCompleteHandler } from "./text-complete";
import { createNudgePlacementStore, createTransform } from "./transform";

export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";

import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";
import {
    createChatMessageHook,
    createCommandExecuteBeforeHook,
    createEventHook,
    createToolExecuteAfterHook,
    getLiveNotificationParams,
} from "./hook-handlers";
import type { LiveSessionState } from "./live-session-state";
import { sendIgnoredMessage } from "./send-session-notification";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { maybeSendUpgradeReminder } from "./upgrade-reminder";

const DREAM_SCHEDULE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// NOTE: lastScheduleCheckMs is intentionally inside createMagicContextHook (not module scope)
// so each hook instance has independent dream-schedule tracking across projects.

export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    liveSessionState?: LiveSessionState;
    config: {
        protected_tags: number;
        ctx_reduce_enabled?: boolean;
        nudge_interval_tokens?: number;
        auto_drop_tool_age?: number;
        drop_tool_structure?: boolean;
        clear_reasoning_age?: number;
        iteration_nudge_threshold?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: string | Record<string, string>;

        historian?: HistorianConfig;
        history_budget_percentage?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
            /** When true, historian/recomp auto-promote eligible session facts
             *  to project memories. When false, promotion is skipped. Issue #44. */
            auto_promote?: boolean;
            /** Graduated from experimental.auto_search; now memory-scoped. */
            auto_search?: {
                enabled: boolean;
                score_threshold: number;
                min_prompt_chars: number;
            };
        };
        embedding?: {
            provider?: "local" | "openai-compatible" | "off";
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
        /** Issue #53: per-agent system-prompt injection opt-out. Optional in
         *  the inline type so legacy tests/callers don't have to construct it;
         *  Zod's .default() guarantees it's present in real loaded configs. */
        system_prompt_injection?: { enabled: boolean; skip_signatures: string[] };
        temporal_awareness?: boolean;
        caveman_text_compression?: {
            enabled: boolean;
            min_chars: number;
        };
    };
}

function notifyMagicContextDisabled(client: PluginContext["client"], reason: string): void {
    const detail = reason.trim();
    // Intentional: feature-detection cast for optional/experimental OpenCode tui.showToast API
    const c = client as {
        tui?: {
            showToast?: (input: {
                body: {
                    title: string;
                    message: string;
                    variant?: "warning" | "error" | "info" | "success";
                    duration?: number;
                };
            }) => Promise<unknown>;
        };
    };

    const message =
        detail.length > 0
            ? `Persistent storage is unavailable, so magic-context is disabled for safety. ${detail}`
            : "Persistent storage is unavailable, so magic-context is disabled for safety.";

    void c.tui
        ?.showToast?.({
            body: {
                title: "Magic Context Disabled",
                message,
                variant: "warning",
                duration: 8000,
            },
        })
        .catch((error) => {
            log("[magic-context] failed to show disabled toast:", error);
        });
}

export function createMagicContextHook(deps: MagicContextDeps) {
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
    let db: Database;
    try {
        const opened = openDatabase();
        if (!opened || !isDatabasePersisted(opened)) {
            const reason =
                (opened ? getDatabasePersistenceError(opened) : null) ??
                "Failed to initialize the persistent SQLite database.";
            log(
                "[magic-context] disabling feature because persistent storage is unavailable:",
                reason,
            );
            notifyMagicContextDisabled(deps.client, reason);
            return null;
        }
        db = opened;
    } catch (error) {
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        return null;
    }

    const projectPath = resolveProjectIdentity(deps.directory);
    registerDreamProjectDirectory(projectPath, deps.directory);

    // Startup consistency check: reconcile any compaction markers whose state
    // references rows that no longer exist in OpenCode's DB. This can happen
    // if the plugin crashed between DB writes (context.db + opencode.db are
    // separate stores with no cross-DB transaction) or if OpenCode's DB was
    // modified externally.
    try {
        checkCompactionMarkerConsistency(db);
    } catch (error) {
        log("[magic-context] startup compaction-marker consistency check failed:", error);
    }

    let lastScheduleCheckMs = 0;

    // Derive historian chunk budget from the historian model's own context window.
    // Historian is a single-shot summarizer, so its input is bounded by its OWN
    // context, not the main session model's. Re-derived per historian invocation
    // (matching RPC/TUI paths) so config/model changes take effect without
    // restart, and so all trigger sources produce consistent chunk sizes.
    const getHistorianChunkTokens = (): number =>
        deriveHistorianChunkTokens(resolveHistorianContextLimit(deps.config.historian?.model));
    const historianFallbackModels = resolveFallbackChain(
        HISTORIAN_AGENT,
        deps.config.historian?.fallback_models,
    );

    const nudgePlacements = createNudgePlacementStore(db);
    // Three independent cache-busting signal sets, sourced from the
    // process-scoped LiveSessionState so RPC handlers (TUI recomp) can
    // share the same instances as the hook (server /ctx-recomp). When
    // `liveSessionState` is omitted (test-only path), fall back to local
    // sets — the production index.ts always provides one. See
    // live-session-state.ts and hook-handlers.ts doc-comments for the
    // full split rationale.
    const historyRefreshSessions =
        deps.liveSessionState?.historyRefreshSessions ?? new Set<string>();
    const deferredHistoryRefreshSessions =
        deps.liveSessionState?.deferredHistoryRefreshSessions ?? new Set<string>();

    // Plan v6 §7: hook-init rehydration of deferred-marker drain state. A
    // publish that wrote `pending_compaction_marker_state` before the plugin
    // process exited (crash, restart) must still get its drain pass; seed
    // `deferredHistoryRefreshSessions` from the persisted pending blobs so the
    // next consuming transform pass picks them up via
    // `applyDeferredCompactionMarker`. Idempotent — running twice just re-adds
    // the same session ids to the Set.
    try {
        const sessionsWithPending = getSessionsWithPendingMarker(db);
        if (sessionsWithPending.length > 0) {
            for (const sid of sessionsWithPending) {
                deferredHistoryRefreshSessions.add(sid);
            }
            log(
                `[magic-context] rehydrated ${sessionsWithPending.length} session(s) with pending compaction-marker drain at hook init`,
            );
        }
    } catch (error) {
        log("[magic-context] hook init: pending-marker rehydration failed:", error);
    }

    const systemPromptRefreshSessions =
        deps.liveSessionState?.systemPromptRefreshSessions ?? new Set<string>();
    const pendingMaterializationSessions =
        deps.liveSessionState?.pendingMaterializationSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.liveSessionState?.deferredMaterializationSessions ?? new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession =
        deps.liveSessionState?.variantBySession ?? new Map<string, string | undefined>();
    const liveModelBySession =
        deps.liveSessionState?.liveModelBySession ??
        new Map<string, { providerID: string; modelID: string }>();
    const agentBySession = deps.liveSessionState?.agentBySession ?? new Map<string, string>();
    const sessionDirectoryBySession =
        deps.liveSessionState?.sessionDirectoryBySession ?? new Map<string, string>();
    const internalChildSessions = deps.liveSessionState?.internalChildSessions ?? new Set<string>();
    // Recomp/upgrade progress map — shared with the RPC sidebar/status snapshot
    // when liveSessionState is provided (production), local fallback in tests.
    const recompProgressBySession =
        deps.liveSessionState?.recompProgressBySession ??
        new Map<string, import("./compartment-runner-types").RecompProgress>();
    const recentReduceBySession = new Map<string, number>();
    const toolUsageSinceUserTurn = new Map<string, number>();

    /**
     * Return the live provider/model for a session.
     *
     * Prefers the in-memory `liveModelBySession` map populated by transform passes
     * and `chat.message` hooks. When the map is empty (for example `/ctx-status`
     * is invoked before any transform pass has run since restart), falls back to
     * reading the last assistant message from OpenCode's SQLite DB and caches the
     * result so subsequent calls in the same process don't hit the DB again.
     *
     * Returns undefined only for brand-new sessions with no assistant turn yet.
     */
    const resolveLiveModel = (
        sessionId: string,
    ): { providerID: string; modelID: string } | undefined => {
        const cached = liveModelBySession.get(sessionId);
        if (cached) return cached;
        const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
        if (recovered) {
            liveModelBySession.set(sessionId, recovered);
            return recovered;
        }
        return undefined;
    };
    const ctxReduceEnabled = deps.config.ctx_reduce_enabled !== false;
    const dreamerRunnable = isDreamerRunnable(deps.config);
    const dreamerConfig = dreamerRunnable ? deps.config.dreamer : undefined;
    const historianRunnable = isHistorianRunnable(deps.config);

    // Shared context for the recomp/upgrade orchestrator. Both `/ctx-recomp` and
    // `/ctx-session-upgrade` (command paths) build this so they run through the
    // exact same runner as the RPC dialog paths — identical fallback, progress,
    // and terminal state. `fallbackModelId` is resolved here with the OpenCode-DB
    // recovery (resolveLiveModel) so the last-resort fallback model is known even
    // when a command is invoked before the first transform pass populates the map.
    const buildManagedRecompCtx = (sessionId: string): ManagedRecompContext => ({
        client: deps.client,
        db,
        // Pass the SAME map/set instances the hook uses so the orchestrator's
        // writes (progress, session-dir cache, refresh signals) propagate to the
        // shared live state — and the next transform pass + RPC sidebar see them.
        liveSessionState: {
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            sessionDirectoryBySession,
            recompProgressBySession,
            internalChildSessions,
        },
        directory: deps.directory,
        historianChunkTokens: getHistorianChunkTokens(),
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        memoryEnabled: deps.config.memory?.enabled ?? true,
        autoPromote: deps.config.memory?.auto_promote ?? true,
        embeddingEnabled: deps.config.embedding?.provider !== "off",
        fallbackModels: historianFallbackModels,
        fallbackModelId: (() => {
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        })(),
        historianTwoPass: deps.config.historian?.two_pass === true,
        runMigration: deps.config.memory?.enabled !== false && !!deps.config.historian?.model,
        userMemoriesEnabled: dreamerConfig?.user_memories?.enabled === true,
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getNotificationParams: (sid) =>
            getLiveNotificationParams(sid, liveModelBySession, variantBySession, agentBySession),
    });
    const sidekickRunnable = isSidekickRunnable(deps.config);
    const sidekickConfig = sidekickRunnable ? deps.config.sidekick : undefined;
    const nudgerWithRecentReduce = ctxReduceEnabled
        ? createNudger({
              protected_tags: deps.config.protected_tags,
              nudge_interval_tokens:
                  deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
              iteration_nudge_threshold: deps.config.iteration_nudge_threshold ?? 15,
              execute_threshold_percentage: deps.config.execute_threshold_percentage ?? 65,
              recentReduceBySession,
          })
        : () => null;

    const transform = createTransform({
        tagger: deps.tagger,
        scheduler: deps.scheduler,
        contextUsageMap,
        nudger: nudgerWithRecentReduce,
        db,
        nudgePlacements,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        autoDropToolAge: deps.config.auto_drop_tool_age ?? 100,
        dropToolStructure: deps.config.drop_tool_structure ?? true,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        internalChildSessions,
        client: deps.client,
        directory: deps.directory,
        memoryConfig: deps.config.memory
            ? {
                  enabled: deps.config.memory.enabled,
                  injectionBudgetTokens: deps.config.memory.injection_budget_tokens,
                  // Issue #44: thread auto_promote through. Default true to
                  // preserve historical behavior when the field is missing.
                  autoPromote: deps.config.memory.auto_promote ?? true,
              }
            : undefined,
        embeddingEnabled: deps.config.embedding?.provider !== "off",
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getHistorianChunkTokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        executeThresholdPercentage: deps.config.execute_threshold_percentage,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        fallbackModels: historianFallbackModels,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
            ),
        getModelKey: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return resolveModelKey(model?.providerID, model?.modelID);
        },
        getToolSetHash: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            if (!model) return "";
            return getCurrentToolSetHash(
                model.providerID,
                model.modelID,
                agentBySession.get(sessionId),
            );
        },
        getFallbackModelId: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        projectPath,
        historianRunnable,
        experimentalUserMemories: dreamerConfig?.user_memories?.enabled,
        experimentalPinKeyFiles: dreamerConfig?.pin_key_files?.enabled ?? false,
        experimentalPinKeyFilesTokenBudget: dreamerConfig?.pin_key_files?.token_budget,
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        historianTwoPass: deps.config.historian?.two_pass === true,
        liveModelBySession,
        sessionDirectoryBySession,
        autoSearch: deps.config.memory?.auto_search?.enabled
            ? {
                  enabled: true,
                  scoreThreshold: deps.config.memory?.auto_search.score_threshold,
                  minPromptChars: deps.config.memory?.auto_search.min_prompt_chars,
                  directory: deps.directory,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
              }
            : undefined,
        // Age-tier caveman text compression — only honored when
        // ctx_reduce_enabled: false. Transform gates this itself too, but we
        // avoid wiring the feature at all when ctx_reduce is on so the
        // transform deps stay clean.
        cavemanTextCompression:
            ctxReduceEnabled === false && deps.config.caveman_text_compression?.enabled === true
                ? {
                      enabled: true,
                      minChars: deps.config.caveman_text_compression.min_chars ?? 500,
                  }
                : undefined,
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        tagger: deps.tagger,
        db,
        client: deps.client,
        internalChildSessions,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
            ),
        nudgePlacements,
        onSessionCacheInvalidated: (sessionId: string) => {
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
        // Clean up per-session state the system-prompt handler maintains so
        // these module/closure-scope maps don't accumulate entries over the
        // plugin's lifetime (Finding #3).
        onSessionDeleted: (sessionId: string) => {
            systemPromptHash.clearSession(sessionId);
            // Prune every per-session map this hook closure owns. These
            // accumulate one entry per session for the plugin process lifetime
            // (which can span days/weeks across many sessions and subagents);
            // without this, a long-lived process leaks memory steadily. Some
            // maps are shared via liveSessionState — clearing on the terminal
            // session.deleted event is correct since the session is gone.
            lastHeuristicsTurnId.delete(sessionId);
            commitSeenLastPass.delete(sessionId);
            variantBySession.delete(sessionId);
            liveModelBySession.delete(sessionId);
            agentBySession.delete(sessionId);
            sessionDirectoryBySession.delete(sessionId);
            recompProgressBySession.delete(sessionId);
            recentReduceBySession.delete(sessionId);
            toolUsageSinceUserTurn.delete(sessionId);
            internalChildSessions.delete(sessionId);
        },
    });

    const runDreamQueueInBackground = (): void => {
        const dreaming = deps.config.dreamer;
        if (!dreaming || dreaming.disable === true || !dreaming.schedule?.trim()) {
            return;
        }

        const now = Date.now();
        if (now - lastScheduleCheckMs < DREAM_SCHEDULE_CHECK_INTERVAL_MS) {
            return;
        }

        try {
            checkScheduleAndEnqueue(db, dreaming.schedule, projectPath);
            lastScheduleCheckMs = now;
        } catch (error) {
            log("[dreamer] scheduled enqueue check failed:", error);
            return;
        }

        void processDreamQueue({
            db,
            client: deps.client,
            // Run in the directory this hook instance owns, not a stale sibling
            // checkout resolved from the shared git:<sha> identity map.
            sessionDirectoryOverride: deps.directory,
            tasks: dreaming.tasks,
            taskTimeoutMinutes: dreaming.task_timeout_minutes,
            maxRuntimeMinutes: dreaming.max_runtime_minutes,
            experimentalUserMemories: dreaming.user_memories?.enabled
                ? {
                      enabled: true,
                      promotionThreshold: dreaming.user_memories.promotion_threshold,
                  }
                : undefined,
            experimentalPinKeyFiles: dreaming.pin_key_files?.enabled
                ? {
                      enabled: true,
                      token_budget: dreaming.pin_key_files.token_budget,
                      min_reads: dreaming.pin_key_files.min_reads,
                  }
                : undefined,
            fallbackModels: resolveFallbackChain(DREAMER_AGENT, dreaming.fallback_models),
            projectIdentity: projectPath,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled queue processing failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        nudgeIntervalTokens: deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        getLiveModelKey: (sessionId) => {
            // Use DB fallback so /ctx-status shows the correct model-specific
            // threshold even before the first transform pass has populated
            // liveModelBySession after restart. Without this, the resolver
            // falls back to the default threshold and displays a stale budget.
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        getContextLimit: (sessionId) => {
            // Same DB fallback as getLiveModelKey — /ctx-status's "Resolved
            // context limit" and history-budget math depend on the live model.
            const model = resolveLiveModel(sessionId);
            if (!model) return undefined;
            return resolveContextLimit(model.providerID, model.modelID);
        },
        // /ctx-flush is a user-initiated full refresh: signal all three sets.
        // History rebuild + system-prompt adjuncts + force materialize.
        onFlush: (sessionId) => {
            historyRefreshSessions.add(sessionId);
            systemPromptRefreshSessions.add(sessionId);
            pendingMaterializationSessions.add(sessionId);
        },
        // E3 (recomp) + /ctx-session-upgrade: both run through the SHARED
        // orchestrator (runManagedRecomp / runManagedUpgrade) so the command
        // paths get identical model fallback + live progress + terminal state as
        // the RPC dialog paths. Dogfood 2026-05-30: previously the command path
        // had fallback but no progress (sidebar stuck on stale "failed") while
        // the RPC dialog had progress but no fallback (failed on empty primary
        // model). One runner closes both gaps.
        executeRecomp: historianRunnable
            ? async (sessionId, options) =>
                  runManagedRecomp(buildManagedRecompCtx(sessionId), sessionId, options)
            : undefined,
        // E3.2 — /ctx-session-upgrade: full recomp + once-per-project memory
        // migration in one managed run. The command handler delivers the result.
        runUpgrade: historianRunnable
            ? async (sessionId: string) =>
                  runManagedUpgrade(buildManagedRecompCtx(sessionId), sessionId)
            : undefined,
        sendNotification: async (sessionId, text, params) => {
            await sendIgnoredMessage(deps.client, sessionId, text, {
                ...getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                ),
                ...params,
            });
        },
        sidekick: sidekickConfig
            ? {
                  config: sidekickConfig,
                  projectPath,
                  sessionDirectory: deps.directory,
                  client: deps.client,
              }
            : undefined,
        dreamer: dreamerConfig
            ? {
                  config: dreamerConfig,
                  projectPath,
                  client: deps.client,
                  directory: deps.directory,
                  experimentalUserMemories: dreamerConfig.user_memories?.enabled
                      ? {
                            enabled: true,
                            promotionThreshold: dreamerConfig.user_memories.promotion_threshold,
                        }
                      : undefined,
                  experimentalPinKeyFiles: dreamerConfig.pin_key_files?.enabled
                      ? {
                            enabled: true,
                            token_budget: dreamerConfig.pin_key_files.token_budget,
                            min_reads: dreamerConfig.pin_key_files.min_reads,
                        }
                      : undefined,
                  fallbackModels: resolveFallbackChain(
                      DREAMER_AGENT,
                      dreamerConfig.fallback_models,
                  ),
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        dropToolStructure: deps.config.drop_tool_structure ?? true,
        dreamerEnabled: dreamerRunnable,
        injectDocs: deps.config.dreamer?.inject_docs !== false,
        directory: deps.directory,
        // System-prompt-hash handler reads systemPromptRefreshSessions to
        // decide whether to re-read disk-backed adjuncts (docs, profile,
        // key files, sticky date), and adds to all three sets when it
        // detects a real prompt-content change.
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        // Issue #53: per-agent injection opt-out via config.
        // Defensive defaults for tests/legacy callers that pre-date the
        // schema field; Zod's .default() handles real loaded configs.
        injectionEnabled: deps.config.system_prompt_injection?.enabled ?? true,
        injectionSkipSignatures: deps.config.system_prompt_injection?.skip_signatures ?? [
            "<!-- magic-context: skip -->",
        ],
        internalChildSessions,
        experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled,
        experimentalPinKeyFiles: deps.config.dreamer?.pin_key_files?.enabled ?? false,
        experimentalPinKeyFilesTokenBudget: deps.config.dreamer?.pin_key_files?.token_budget,
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        // Caveman text compression only runs when ctx_reduce_enabled === false
        // (gated in transform.ts and in hook.ts cavemanTextCompression wiring above).
        // Mirror that gate here so the prompt warning never appears in modes where
        // caveman won't actually compress anything.
        experimentalCavemanTextCompression:
            ctxReduceEnabled === false && deps.config.caveman_text_compression?.enabled === true,
    });
    const systemPromptHashHandler = systemPromptHash.handler;

    const eventHook = createEventHook({
        eventHandler,
        contextUsageMap,
        db,
        liveModelBySession,
        variantBySession,
        agentBySession,
        sessionDirectoryBySession,
        recentReduceBySession,
        toolUsageSinceUserTurn,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        client: deps.client,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
    });

    return {
        "experimental.chat.messages.transform": transform,
        "experimental.chat.system.transform": systemPromptHashHandler,
        "experimental.text.complete": createTextCompleteHandler(),
        "chat.message": createChatMessageHook({
            db,
            toolUsageSinceUserTurn,
            recentReduceBySession,
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            ctxReduceEnabled,
            // E5 — only offer the upgrade reminder when historian can run (so
            // /ctx-session-upgrade is actually actionable). Self-gates per session.
            upgradeReminder: historianRunnable
                ? (sessionId: string) =>
                      maybeSendUpgradeReminder(
                          {
                              client: deps.client,
                              db,
                              sendIgnoredMessage,
                              getNotificationParams: (sid) =>
                                  getLiveNotificationParams(
                                      sid,
                                      liveModelBySession,
                                      variantBySession,
                                      agentBySession,
                                  ),
                              isTuiConnected,
                              pushTuiDialogAction: (sid, resume) =>
                                  pushNotification(
                                      "action",
                                      resume
                                          ? {
                                                action: "show-upgrade-dialog",
                                                resume: true,
                                                stagedCount: resume.stagedCount,
                                                stagedThrough: resume.stagedThrough,
                                            }
                                          : { action: "show-upgrade-dialog" },
                                      sid,
                                  ),
                          },
                          sessionId,
                      )
                : undefined,
        }),
        event: async (input: { event: { type: string; properties?: unknown } }) => {
            await eventHook(input);
            if (input.event.type === "message.updated") {
                runDreamQueueInBackground();
            }
        },
        "command.execute.before": createCommandExecuteBeforeHook(commandHandler),
        "tool.execute.after": createToolExecuteAfterHook({
            db,
            recentReduceBySession,
            toolUsageSinceUserTurn,
        }),
    };
}

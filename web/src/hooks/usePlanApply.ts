import { useCallback, useRef, useState } from "react";
import { ApplyRequestError, postApplyStream, postFetch, postPlan } from "../api.js";
import type { AlertProgress } from "../components/AlertModal.js";
import type { MetaResponse, Selection, ServerConfig } from "../types.js";
import { formatPlanForDisplay, normalizeConfig, type PlanView, parsePlanView } from "../utils.js";
import type { AlertAction, AlertFlow } from "./useAlertFlow.js";

interface UsePlanApplyArgs {
  config: ServerConfig | null;
  meta: MetaResponse | null;
  /** True when the working config differs from the last saved/fetched snapshot. */
  dirty: boolean;
  setConfig: (next: ServerConfig) => void;
  setSavedSnapshot: (snapshot: string) => void;
  select: (sel: Selection) => void;
  alert: AlertFlow;
  /** Surfaces non-alert errors (e.g. clipboard failures) in the status bar. */
  onError: (message: string) => void;
}

/**
 * Fetch / Plan / Dry-run / Apply run logic: busy flag, plan output panel
 * state, SSE apply progress + cancellation, and the confirm-modal entry
 * points. Extracted from App.tsx (P3 "Split App.tsx").
 */
export function usePlanApply({
  config,
  meta,
  dirty,
  setConfig,
  setSavedSnapshot,
  select,
  alert,
  onError,
}: UsePlanApplyArgs) {
  const { setAlert, showAlertError } = alert;
  const active = config !== null && meta !== null;
  const [busy, setBusy] = useState(false);
  const [planOutput, setPlanOutput] = useState<string | null>(null);
  const [planViewOutput, setPlanViewOutput] = useState<PlanView | null>(null);
  const [showPlanOutput, setShowPlanOutput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [applyProgress, setApplyProgress] = useState<AlertProgress | null>(null);
  /** Prune (delete) items missing from the config when applying. */
  const [applyPrune, setApplyPrune] = useState(false);
  const applyAbortRef = useRef<AbortController | null>(null);

  const resetPlanOutput = useCallback(() => {
    setPlanOutput(null);
    setShowPlanOutput(false);
    setCopiedOutput(false);
  }, []);

  const handleCopyPlanOutput = useCallback(async () => {
    if (!planOutput) return;
    try {
      await navigator.clipboard.writeText(planOutput);
      setCopiedOutput(true);
      window.setTimeout(() => setCopiedOutput(false), 1500);
    } catch {
      onError("Failed to copy output");
    }
  }, [onError, planOutput]);

  const runFetch = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    setAlert({
      open: true,
      action: "fetch",
      phase: "pending",
      title: "Fetch status",
      message: "Fetching live status…",
    });
    try {
      const result = await postFetch();
      if (result.code === "DISCORD_NOT_CONFIGURED" || result.error || !result.ok) {
        showAlertError("fetch", "Fetch failed", result.error ?? "Fetch failed", {
          issues: result.issues,
        });
        return;
      }
      if (!result.config) {
        showAlertError("fetch", "Fetch failed", "Fetch returned no config");
        return;
      }
      const normalized = normalizeConfig(result.config);
      setConfig(normalized);
      setSavedSnapshot(JSON.stringify(normalized));
      select({ kind: "guild" });
      setPlanOutput(null);
      setShowPlanOutput(false);
      setCopiedOutput(false);
      const warnCount = result.warnings?.length ?? 0;
      setAlert({
        open: true,
        action: "fetch",
        phase: "success",
        title: "Fetch status",
        message:
          warnCount > 0
            ? `Fetched live status (${warnCount} warning${warnCount === 1 ? "" : "s"})`
            : "Fetched live status",
      });
    } finally {
      setBusy(false);
    }
  }, [active, setAlert, showAlertError, setConfig, setSavedSnapshot, select]);

  const handleFetch = useCallback(() => {
    if (!active) return;
    if (!meta.discordConfigured) {
      showAlertError(
        "fetch",
        "Fetch unavailable",
        "Fetch unavailable: Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
      );
      return;
    }
    const confirmMsg = dirty
      ? "Fetch live Discord guild status and replace the working config file? You have unsaved edits that will be discarded."
      : "Fetch live Discord guild status and replace the working config file with the current server state?";
    setAlert({
      open: true,
      action: "fetch",
      phase: "confirm",
      title: "Fetch status",
      message: confirmMsg,
      confirmLabel: "Fetch",
    });
  }, [active, dirty, meta?.discordConfigured, setAlert, showAlertError]);

  const runPlan = useCallback(async () => {
    if (!active || !config) return;
    setBusy(true);
    setAlert({
      open: true,
      action: "plan",
      phase: "pending",
      title: "Plan",
      message: "Building plan…",
    });
    try {
      const result = await postPlan(config);
      if (result.code === "DISCORD_NOT_CONFIGURED" || result.error) {
        showAlertError("plan", "Plan failed", result.error ?? "Plan failed", {
          issues: result.issues,
        });
        return;
      }
      const detail = formatPlanForDisplay(result.plan);
      const planView = parsePlanView(result.plan);
      setPlanOutput(detail);
      setPlanViewOutput(planView);
      setShowPlanOutput(true);
      setCopiedOutput(false);
      const warnCount = Array.isArray(
        (result.plan as { warnings?: unknown[] } | undefined)?.warnings,
      )
        ? (result.plan as { warnings: unknown[] }).warnings.length
        : 0;
      setAlert({
        open: true,
        action: "plan",
        phase: "success",
        title: "Plan",
        message:
          warnCount > 0
            ? `Plan ready (${warnCount} warning${warnCount === 1 ? "" : "s"})`
            : "Plan ready",
        detail,
        planView,
      });
    } finally {
      setBusy(false);
    }
  }, [active, config, setAlert, showAlertError]);

  const handlePlan = useCallback(() => {
    if (!active) return;
    if (!meta.discordConfigured) {
      showAlertError(
        "plan",
        "Plan unavailable",
        "Plan unavailable: Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
      );
      return;
    }
    void runPlan();
  }, [active, meta?.discordConfigured, runPlan, showAlertError]);

  const runApply = useCallback(
    async (dryRun: boolean, prune: boolean) => {
      if (!active || !config) return;
      const action: AlertAction = dryRun ? "dry-run" : "apply";
      const title = dryRun ? "Dry-run" : "Apply";
      setBusy(true);
      setApplyProgress(null);
      const controller = new AbortController();
      applyAbortRef.current = controller;
      setAlert({
        open: true,
        action,
        phase: "pending",
        title,
        message: dryRun ? "Running dry-run…" : "Applying config…",
      });
      try {
        const result = await postApplyStream(
          config,
          { dryRun, confirm: !dryRun, prune },
          (p) => {
            setApplyProgress({
              current: p.index + 1,
              total: p.total,
              status: p.status,
              label:
                p.status === "skip"
                  ? `· ${p.type} ${p.resource} (skipped)`
                  : `${p.status === "success" ? "✓" : "✗"} ${p.type} ${p.resource}${p.error ? ` — ${p.error}` : ""}`,
            });
          },
          controller.signal,
        );
        const payload = result.plan ?? result.result;
        const detail = formatPlanForDisplay(payload);
        const planView = parsePlanView(payload);
        setPlanOutput(detail);
        setPlanViewOutput(planView);
        setShowPlanOutput(true);
        setCopiedOutput(false);
        const failedCount = result.result?.failed?.length ?? 0;
        if (result.ok === false || failedCount > 0) {
          setAlert({
            open: true,
            action,
            phase: "error",
            title,
            message: dryRun
              ? `Dry-run finished with ${failedCount} failure${failedCount === 1 ? "" : "s"}`
              : `Apply finished with ${failedCount} failure${failedCount === 1 ? "" : "s"}`,
            detail,
            planView,
          });
          return;
        }
        setAlert({
          open: true,
          action,
          phase: "success",
          title,
          message: dryRun ? "Dry-run complete" : "Apply complete",
          detail,
          planView,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          setAlert({
            open: true,
            action,
            phase: "error",
            title,
            message: dryRun
              ? "Dry-run cancelled. No changes were made."
              : "Apply cancelled. Changes made before the cancel are live — run Plan to see the remaining drift.",
          });
          return;
        }
        if (e instanceof ApplyRequestError) {
          showAlertError(action, `${title} failed`, e.message, {
            issues: e.body.issues,
          });
          return;
        }
        showAlertError(action, `${title} failed`, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setApplyProgress(null);
        applyAbortRef.current = null;
      }
    },
    [active, config, setAlert, showAlertError],
  );

  const handleApply = useCallback(
    (dryRun: boolean) => {
      if (!active) return;
      if (!meta.discordConfigured) {
        showAlertError(
          dryRun ? "dry-run" : "apply",
          dryRun ? "Dry-run unavailable" : "Apply unavailable",
          "Apply unavailable: Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
        );
        return;
      }
      if (!dryRun) {
        setApplyPrune(false);
        setAlert({
          open: true,
          action: "apply",
          phase: "confirm",
          title: "Apply",
          message: "Apply this config to the live Discord guild? This will mutate the server.",
          confirmLabel: "Apply",
          confirmDanger: true,
        });
        return;
      }
      void runApply(true, false);
    },
    [active, meta?.discordConfigured, runApply, setAlert, showAlertError],
  );

  const confirmFetch = useCallback(() => {
    void runFetch();
  }, [runFetch]);

  const confirmApply = useCallback(() => {
    void runApply(false, applyPrune);
  }, [applyPrune, runApply]);

  const cancelApply = useCallback(() => {
    // Abort the streaming apply; runApply's catch renders the cancelled state.
    applyAbortRef.current?.abort();
  }, []);

  return {
    busy,
    planOutput,
    planViewOutput,
    showPlanOutput,
    setShowPlanOutput,
    copiedOutput,
    handleCopyPlanOutput,
    resetPlanOutput,
    applyProgress,
    applyPrune,
    setApplyPrune,
    handleFetch,
    handlePlan,
    handleApply,
    confirmFetch,
    confirmApply,
    cancelApply,
  };
}

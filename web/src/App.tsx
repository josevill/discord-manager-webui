import {
  CaretLeft,
  Hash,
  List,
  PaintBucket,
  SlidersHorizontal,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchConfig, fetchMeta, saveConfig, validateConfig } from "./api.js";
import { AlertModal } from "./components/AlertModal.js";
import { ChannelTree } from "./components/ChannelTree.js";
import { ContentList } from "./components/ContentList.js";
import { Inspector } from "./components/Inspector.js";
import { PlanViewList } from "./components/PlanViewList.js";
import { RolesRail } from "./components/RolesRail.js";
import { useAlertFlow } from "./hooks/useAlertFlow.js";
import { useLayoutMode } from "./hooks/useLayoutMode.js";
import { usePlanApply } from "./hooks/usePlanApply.js";
import type { MetaResponse, Selection, ServerConfig, ValidationIssue } from "./types.js";
import { configToPreview, normalizeConfig, uniqueName } from "./utils.js";

type MobileTab = "roles" | "channels" | "content" | "inspector";

type Status =
  | { kind: "idle"; message?: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; issues?: ValidationIssue[] };

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "guild" });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showJson, setShowJson] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("channels");
  const [rolesOpen, setRolesOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const layoutMode = useLayoutMode();

  const dirty = useMemo(() => {
    if (!config) return false;
    return JSON.stringify(config) !== savedSnapshot;
  }, [config, savedSnapshot]);

  const alertFlow = useAlertFlow();

  const select = useCallback(
    (sel: Selection) => {
      setSelection(sel);
      if (layoutMode === "phone") {
        setMobileTab("inspector");
      } else if (layoutMode === "tablet") {
        setInspectorOpen(true);
        setRolesOpen(false);
        setContentOpen(false);
      }
    },
    [layoutMode],
  );

  // Fetch / Plan / Dry-run / Apply runs (plan output panel, SSE progress,
  // cancel, prune toggle) live in the usePlanApply hook.
  const runs = usePlanApply({
    config,
    meta,
    dirty,
    setConfig,
    setSavedSnapshot,
    select,
    alert: { setAlert: alertFlow.setAlert, showAlertError: alertFlow.showAlertError },
    onError: (message) => setStatus({ kind: "error", message }),
  });
  const { closeAlert } = alertFlow;

  const busy = localBusy || runs.busy;

  const closeDrawers = useCallback(() => {
    setRolesOpen(false);
    setContentOpen(false);
    setInspectorOpen(false);
  }, []);

  useEffect(() => {
    if (layoutMode === "desktop") {
      setRolesOpen(false);
      setContentOpen(false);
      setInspectorOpen(false);
      setActionsOpen(false);
    }
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode !== "tablet") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawers();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layoutMode, closeDrawers]);

  const load = useCallback(async () => {
    const [cfg, m] = await Promise.all([fetchConfig(), fetchMeta()]);
    const normalized = normalizeConfig(cfg.config);
    setConfig(normalized);
    setSavedSnapshot(JSON.stringify(normalized));
    setMeta(m);
    setSelection({ kind: "guild" });
  }, []);

  useEffect(() => {
    void load().catch((e) =>
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      }),
    );
  }, [load]);

  function updateConfig(next: ServerConfig) {
    setConfig(normalizeConfig(next));
    setStatus({ kind: "idle" });
    runs.resetPlanOutput();
  }

  async function handleValidate() {
    if (!config) return;
    setLocalBusy(true);
    try {
      const result = await validateConfig(config);
      if (!result.ok) {
        const issues = [
          ...(result.schemaIssues ?? []).map((i) => ({
            level: "error" as const,
            path: i.path,
            message: i.message,
          })),
          ...(result.issues ?? []),
        ];
        setStatus({
          kind: "error",
          message: "Validation failed",
          issues,
        });
        return;
      }
      const warnings = (result.issues ?? []).filter((i) => i.level === "warning");
      setStatus({
        kind: "success",
        message:
          warnings.length > 0
            ? `Valid (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
            : "Config is valid",
      });
    } finally {
      setLocalBusy(false);
    }
  }

  async function handleSave() {
    if (!config) return;
    setLocalBusy(true);
    try {
      const result = await saveConfig(config);
      if (!result.ok) {
        const issues = [
          ...(result.schemaIssues ?? []).map((i) => ({
            level: "error" as const,
            path: i.path,
            message: i.message,
          })),
          ...(result.issues ?? []),
        ];
        setStatus({
          kind: "error",
          message: result.error ?? "Save rejected",
          issues,
        });
        return;
      }
      const normalized = normalizeConfig(result.config ?? config);
      setConfig(normalized);
      setSavedSnapshot(JSON.stringify(normalized));
      setStatus({ kind: "success", message: "Saved" });
    } finally {
      setLocalBusy(false);
    }
  }

  function handleAlertCancel() {
    const alert = alertFlow.alert;
    if (
      alert.open &&
      alert.phase === "pending" &&
      (alert.action === "apply" || alert.action === "dry-run")
    ) {
      // Abort the streaming apply; runApply's catch renders the cancelled state.
      runs.cancelApply();
      return;
    }
    closeAlert();
  }

  function handleAlertConfirm() {
    const alert = alertFlow.alert;
    if (!alert.open || alert.phase !== "confirm") return;
    if (alert.action === "fetch") {
      runs.confirmFetch();
      return;
    }
    if (alert.action === "apply") {
      runs.confirmApply();
    }
  }

  function addRole() {
    if (!config) return;
    const roles = config.roles ?? [];
    const name = uniqueName(
      "role",
      roles.map((r) => r.name),
    );
    const next = [
      ...roles,
      {
        name,
        color: 0x5865f2,
        hoist: false,
        mentionable: false,
        permissions: ["VIEW_CHANNEL"],
        position: roles.length + 1,
      },
    ];
    updateConfig({ ...config, roles: next });
    select({ kind: "role", index: next.length - 1 });
  }

  function addCategory() {
    if (!config) return;
    const categories = config.categories ?? [];
    const name = uniqueName(
      "Category",
      categories.map((c) => c.name),
    );
    const next = [...categories, { name, position: categories.length, permission_overwrites: [] }];
    updateConfig({ ...config, categories: next });
    select({ kind: "category", index: next.length - 1 });
  }

  function addChannel(categoryName: string | null) {
    if (!config) return;
    const channels = config.channels ?? [];
    const name = uniqueName(
      "channel",
      channels.map((c) => c.name),
    );
    const next = [
      ...channels,
      {
        name,
        type: "text" as const,
        category: categoryName,
        topic: null,
        nsfw: false,
        slowmode: 0,
        permission_overwrites: [],
      },
    ];
    updateConfig({ ...config, channels: next });
    select({ kind: "channel", index: next.length - 1 });
  }

  function addEmoji() {
    if (!config) return;
    const emojis = config.emojis ?? [];
    const name = uniqueName(
      "emoji",
      emojis.map((e) => e.name),
    );
    const next = [...emojis, { name, image: "", roles: [] }];
    updateConfig({ ...config, emojis: next });
    select({ kind: "emoji", index: next.length - 1 });
  }

  function addWebhook() {
    if (!config) return;
    const webhooks = config.webhooks ?? [];
    const name = uniqueName(
      "webhook",
      webhooks.map((w) => w.name),
    );
    const firstChannel = (config.channels ?? [])[0]?.name ?? "";
    const next = [...webhooks, { name, channel: firstChannel, avatar: null }];
    updateConfig({ ...config, webhooks: next });
    select({ kind: "webhook", index: next.length - 1 });
  }

  function addAutoModRule() {
    if (!config) return;
    const rules = config.auto_mod?.rules ?? [];
    const name = uniqueName(
      "Rule",
      rules.map((r) => r.name),
    );
    const next: NonNullable<ServerConfig["auto_mod"]>["rules"] = [
      ...rules,
      {
        name,
        enabled: true,
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { keywords: [] },
        actions: [{ type: 2 }],
        exempt_roles: [],
        exempt_channels: [],
      },
    ];
    updateConfig({ ...config, auto_mod: { rules: next } });
    select({ kind: "autoMod", index: next.length - 1 });
  }

  function deleteSelection() {
    if (!config || !selection) return;
    if (selection.kind === "guild") return;
    if (selection.kind === "role") {
      const roles = [...(config.roles ?? [])];
      roles.splice(selection.index, 1);
      updateConfig({ ...config, roles });
      select({ kind: "guild" });
      return;
    }
    if (selection.kind === "category") {
      const categories = [...(config.categories ?? [])];
      const removed = categories[selection.index];
      categories.splice(selection.index, 1);
      const channels = (config.channels ?? []).map((ch) =>
        ch.category === removed?.name ? { ...ch, category: null } : ch,
      );
      updateConfig({ ...config, categories, channels });
      select({ kind: "guild" });
      return;
    }
    if (selection.kind === "channel") {
      const channels = [...(config.channels ?? [])];
      channels.splice(selection.index, 1);
      updateConfig({ ...config, channels });
      select({ kind: "guild" });
      return;
    }
    if (selection.kind === "emoji") {
      const emojis = [...(config.emojis ?? [])];
      emojis.splice(selection.index, 1);
      updateConfig({ ...config, emojis });
      select({ kind: "guild" });
      return;
    }
    if (selection.kind === "webhook") {
      const webhooks = [...(config.webhooks ?? [])];
      webhooks.splice(selection.index, 1);
      updateConfig({ ...config, webhooks });
      select({ kind: "guild" });
      return;
    }
    if (selection.kind === "autoMod") {
      const rules = [...(config.auto_mod?.rules ?? [])];
      rules.splice(selection.index, 1);
      updateConfig({ ...config, auto_mod: { rules } });
      select({ kind: "guild" });
    }
  }

  function runAndCloseActions(fn: () => void) {
    setActionsOpen(false);
    fn();
  }

  if (!config || !meta) {
    return (
      <div className="loading" data-testid="loading">
        <div className="loading-inner">
          <div className="loading-pulse" aria-hidden />
          <span>Loading config…</span>
        </div>
      </div>
    );
  }

  const compact = layoutMode !== "desktop";
  const drawerOpen = rolesOpen || contentOpen || inspectorOpen;
  const alert = alertFlow.alert;

  return (
    <div className="app" data-testid="app" data-layout={layoutMode}>
      <header className="header">
        <div className="header-brand">
          <div className="brand-mark" aria-hidden />
          <div className="brand-copy">
            <span className="brand-name">discord-manager</span>
            <span className="brand-sub">Visual guild builder</span>
          </div>
        </div>
        <div className="header-guild">
          <button
            type="button"
            className={`list-item${selection?.kind === "guild" ? " active" : ""}`}
            onClick={() => select({ kind: "guild" })}
            data-testid="select-guild"
          >
            Server
          </button>
          <input
            data-testid="header-guild-name"
            value={config.guild?.name ?? ""}
            onChange={(e) =>
              updateConfig({
                ...config,
                guild: { ...config.guild, name: e.target.value },
              })
            }
            placeholder="Guild name"
          />
          {dirty ? (
            <span className="dirty-badge" data-testid="dirty-badge">
              Unsaved
            </span>
          ) : null}
          <span
            className={`conn-badge${meta.discordConfigured ? " online" : ""}`}
            title={
              meta.discordConfigured
                ? "DISCORD_TOKEN and DISCORD_GUILD_ID are set"
                : "Fetch / Plan / Apply need DISCORD_TOKEN and DISCORD_GUILD_ID"
            }
          >
            {meta.discordConfigured ? "Discord ready" : "Local only"}
          </span>
        </div>
        {compact ? (
          <div className="header-actions-compact">
            {layoutMode === "tablet" ? (
              <fieldset className="seg-control" aria-label="Side panels">
                <button
                  type="button"
                  className={`seg-control-btn${rolesOpen ? " active" : ""}`}
                  onClick={() => {
                    setRolesOpen((v) => !v);
                    setContentOpen(false);
                    setInspectorOpen(false);
                  }}
                  data-testid="toggle-roles-drawer"
                >
                  Roles
                </button>
                <button
                  type="button"
                  className={`seg-control-btn${contentOpen ? " active" : ""}`}
                  onClick={() => {
                    setContentOpen((v) => !v);
                    setRolesOpen(false);
                    setInspectorOpen(false);
                  }}
                  data-testid="toggle-content-drawer"
                >
                  Content
                </button>
                <button
                  type="button"
                  className={`seg-control-btn${inspectorOpen ? " active" : ""}`}
                  onClick={() => {
                    setInspectorOpen((v) => !v);
                    setRolesOpen(false);
                    setContentOpen(false);
                  }}
                  data-testid="toggle-inspector-drawer"
                >
                  Edit
                </button>
              </fieldset>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-compact-save"
              disabled={busy || !dirty}
              onClick={() => void handleSave()}
              data-testid="btn-save-shortcut"
            >
              Save
            </button>
            <details
              className="header-actions-menu"
              open={actionsOpen}
              onToggle={(e) => setActionsOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary
                className="btn btn-outline btn-icon"
                data-testid="actions-menu"
                aria-label="Actions"
                title="Actions"
              >
                <List size={18} weight="bold" />
              </summary>
              <div className="header-actions-menu-panel">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => runAndCloseActions(() => setShowJson((v) => !v))}
                  data-testid="toggle-json"
                >
                  {showJson ? "Hide JSON" : "Show JSON"}
                </button>
                <button
                  type="button"
                  className="menu-item"
                  disabled={!runs.planOutput}
                  onClick={() => runAndCloseActions(() => runs.setShowPlanOutput((v) => !v))}
                  data-testid="toggle-plan-output"
                >
                  {runs.showPlanOutput ? "Hide output" : "Show output"}
                </button>
                <div className="menu-divider" aria-hidden />
                <button
                  type="button"
                  className="menu-item"
                  disabled={busy}
                  onClick={() => runAndCloseActions(() => void handleValidate())}
                  data-testid="btn-validate"
                >
                  Validate
                </button>
                <button
                  type="button"
                  className="menu-item menu-item-accent"
                  disabled={busy || !dirty}
                  onClick={() => runAndCloseActions(() => void handleSave())}
                  data-testid="btn-save"
                >
                  Save
                </button>
                <div className="menu-divider" aria-hidden />
                <button
                  type="button"
                  className="menu-item"
                  disabled={busy || !meta.discordConfigured}
                  onClick={() => runAndCloseActions(() => void runs.handleFetch())}
                  data-testid="btn-fetch"
                  title={
                    meta.discordConfigured
                      ? "Pull live guild state into the working config"
                      : "Requires DISCORD_TOKEN and DISCORD_GUILD_ID"
                  }
                >
                  Fetch status
                </button>
                <button
                  type="button"
                  className="menu-item"
                  disabled={busy}
                  onClick={() => runAndCloseActions(() => void runs.handlePlan())}
                  data-testid="btn-plan"
                  title={
                    meta.discordConfigured
                      ? "Build action plan against live guild"
                      : "Requires DISCORD_TOKEN and DISCORD_GUILD_ID"
                  }
                >
                  Plan
                </button>
                <button
                  type="button"
                  className="menu-item"
                  disabled={busy}
                  onClick={() => runAndCloseActions(() => void runs.handleApply(true))}
                  data-testid="btn-dry-run"
                >
                  Dry-run
                </button>
                <button
                  type="button"
                  className="menu-item menu-item-danger"
                  disabled={busy || !meta.discordConfigured}
                  onClick={() => runAndCloseActions(() => void runs.handleApply(false))}
                  data-testid="btn-apply"
                >
                  Apply
                </button>
              </div>
            </details>
          </div>
        ) : (
          <div className="header-actions header-actions-desktop">
            <div className="action-group">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowJson((v) => !v)}
                data-testid="toggle-json"
              >
                {showJson ? "Hide JSON" : "Show JSON"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!runs.planOutput}
                onClick={() => runs.setShowPlanOutput((v) => !v)}
                data-testid="toggle-plan-output"
              >
                {runs.showPlanOutput ? "Hide output" : "Show output"}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy}
                onClick={() => void handleValidate()}
                data-testid="btn-validate"
              >
                Validate
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !dirty}
                onClick={() => void handleSave()}
                data-testid="btn-save"
              >
                Save
              </button>
            </div>
            <div className="action-divider" aria-hidden />
            <div className="action-group">
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy || !meta.discordConfigured}
                onClick={() => void runs.handleFetch()}
                data-testid="btn-fetch"
                title={
                  meta.discordConfigured
                    ? "Pull live guild state into the working config"
                    : "Requires DISCORD_TOKEN and DISCORD_GUILD_ID"
                }
              >
                Fetch status
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy}
                onClick={() => void runs.handlePlan()}
                data-testid="btn-plan"
                title={
                  meta.discordConfigured
                    ? "Build action plan against live guild"
                    : "Requires DISCORD_TOKEN and DISCORD_GUILD_ID"
                }
              >
                Plan
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy}
                onClick={() => void runs.handleApply(true)}
                data-testid="btn-dry-run"
              >
                Dry-run
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || !meta.discordConfigured}
                onClick={() => void runs.handleApply(false)}
                data-testid="btn-apply"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="workspace" data-mobile-tab={mobileTab}>
        {layoutMode === "tablet" && drawerOpen ? (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="Close panel"
            data-testid="drawer-backdrop"
            onClick={closeDrawers}
          />
        ) : null}
        <div className={`pane-shell${rolesOpen ? " is-open" : ""}`} data-pane="roles">
          {layoutMode === "tablet" ? (
            <button
              type="button"
              className="drawer-close drawer-close-start btn btn-sm btn-ghost btn-icon"
              onClick={() => setRolesOpen(false)}
              data-testid="close-roles-drawer"
              aria-label="Close roles"
            >
              <CaretLeft size={16} weight="bold" />
            </button>
          ) : null}
          <RolesRail
            roles={config.roles ?? []}
            selection={selection}
            onSelect={select}
            onReorder={(roles) => updateConfig({ ...config, roles })}
            onAdd={addRole}
          />
        </div>
        <div className={`pane-shell${contentOpen ? " is-open" : ""}`} data-pane="content">
          {layoutMode === "tablet" ? (
            <button
              type="button"
              className="drawer-close drawer-close-start btn btn-sm btn-ghost btn-icon"
              onClick={() => setContentOpen(false)}
              data-testid="close-content-drawer"
              aria-label="Close content"
            >
              <CaretLeft size={16} weight="bold" />
            </button>
          ) : null}
          <ContentList
            emojis={config.emojis ?? []}
            webhooks={config.webhooks ?? []}
            autoModRules={config.auto_mod?.rules ?? []}
            selection={selection}
            onSelect={select}
            onAddEmoji={addEmoji}
            onAddWebhook={addWebhook}
            onAddAutoModRule={addAutoModRule}
          />
        </div>
        <div className="pane-shell" data-pane="channels">
          <ChannelTree
            categories={config.categories ?? []}
            channels={config.channels ?? []}
            selection={selection}
            onSelect={select}
            onReorderChannels={(channels) => updateConfig({ ...config, channels })}
            onAddCategory={addCategory}
            onAddChannel={addChannel}
          />
        </div>
        <div className={`pane-shell${inspectorOpen ? " is-open" : ""}`} data-pane="inspector">
          {layoutMode === "tablet" ? (
            <button
              type="button"
              className="drawer-close drawer-close-end btn btn-sm btn-ghost btn-icon"
              onClick={() => setInspectorOpen(false)}
              data-testid="close-inspector-drawer"
              aria-label="Close editor"
            >
              <X size={16} weight="bold" />
            </button>
          ) : null}
          <Inspector
            config={config}
            selection={selection}
            meta={meta}
            onChange={updateConfig}
            onDelete={deleteSelection}
          />
        </div>
      </div>

      {showJson ? (
        <div className="json-panel" data-testid="json-preview">
          <div className="json-panel-header">
            <span>Config preview (JSON)</span>
          </div>
          <pre>{configToPreview(config)}</pre>
        </div>
      ) : null}

      {runs.planOutput && runs.showPlanOutput ? (
        <div className="json-panel" data-testid="plan-output">
          <div className="json-panel-header">
            <span>Plan / apply output</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => runs.setShowPlanOutput(false)}
              data-testid="hide-plan-output"
            >
              Hide
            </button>
          </div>
          <div className={`json-panel-body${runs.planViewOutput ? " has-plan" : ""}`}>
            <button
              type="button"
              className="btn btn-sm btn-outline json-panel-copy"
              onClick={() => void runs.handleCopyPlanOutput()}
              data-testid="copy-plan-output"
            >
              {runs.copiedOutput ? "Copied" : "Copy JSON"}
            </button>
            {runs.planViewOutput ? (
              <PlanViewList view={runs.planViewOutput} />
            ) : (
              <pre>{runs.planOutput}</pre>
            )}
          </div>
        </div>
      ) : null}

      <div
        className={`status-bar${status.kind === "error" ? " error" : status.kind === "success" ? " success" : ""}`}
        data-testid="status-bar"
        role="status"
      >
        {status.kind === "idle" && !status.message ? (
          <div className="status-bar-line">
            <span>Editing</span>
            <span className="status-path" title={meta.configPath}>
              {meta.configPath}
            </span>
            {!meta.discordConfigured ? (
              <span className="status-hint">Fetch/Plan/Apply need Discord credentials</span>
            ) : null}
          </div>
        ) : null}
        {status.message ? <div data-testid="status-message">{status.message}</div> : null}
        {status.kind === "error" && status.issues
          ? status.issues
              .filter((i) => i.level === "error")
              .map((i, idx) => (
                <div key={`${i.path}-${idx}`} className="issue" data-testid="validation-issue">
                  {i.path}: {i.message}
                </div>
              ))
          : null}
      </div>

      {layoutMode === "phone" ? (
        <nav className="mobile-nav" data-testid="mobile-nav" aria-label="Builder sections">
          <button
            type="button"
            className={`mobile-nav-btn${mobileTab === "roles" ? " active" : ""}`}
            onClick={() => setMobileTab("roles")}
            data-testid="nav-roles"
          >
            <UsersThree size={20} weight={mobileTab === "roles" ? "fill" : "regular"} />
            <span>Roles</span>
          </button>
          <button
            type="button"
            className={`mobile-nav-btn${mobileTab === "channels" ? " active" : ""}`}
            onClick={() => setMobileTab("channels")}
            data-testid="nav-channels"
          >
            <Hash size={20} weight={mobileTab === "channels" ? "bold" : "regular"} />
            <span>Channels</span>
          </button>
          <button
            type="button"
            className={`mobile-nav-btn${mobileTab === "content" ? " active" : ""}`}
            onClick={() => setMobileTab("content")}
            data-testid="nav-content"
          >
            <PaintBucket size={20} weight={mobileTab === "content" ? "fill" : "regular"} />
            <span>Content</span>
          </button>
          <button
            type="button"
            className={`mobile-nav-btn${mobileTab === "inspector" ? " active" : ""}`}
            onClick={() => setMobileTab("inspector")}
            data-testid="nav-inspector"
          >
            <SlidersHorizontal size={20} weight={mobileTab === "inspector" ? "fill" : "regular"} />
            <span>Edit</span>
          </button>
        </nav>
      ) : null}

      <AlertModal
        open={alert.open}
        phase={alert.open ? alert.phase : "pending"}
        title={alert.open ? alert.title : ""}
        message={alert.open ? alert.message : ""}
        issues={alert.open ? alert.issues : undefined}
        detail={alert.open ? alert.detail : undefined}
        planView={alert.open ? alert.planView : undefined}
        confirmLabel={alert.open ? alert.confirmLabel : undefined}
        confirmDanger={alert.open ? alert.confirmDanger : undefined}
        confirmExtra={
          alert.open && alert.phase === "confirm" && alert.action === "apply" ? (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={runs.applyPrune}
                onChange={(e) => runs.setApplyPrune(e.target.checked)}
                data-testid="apply-prune-checkbox"
              />
              <span>
                Also prune (delete) resources that exist in the guild but not in this config —
                roles, categories, channels, emojis, webhooks, and auto-mod rules
              </span>
            </label>
          ) : undefined
        }
        progress={
          alert.open && (alert.action === "apply" || alert.action === "dry-run")
            ? runs.applyProgress
            : null
        }
        cancelPending={
          alert.open &&
          alert.phase === "pending" &&
          (alert.action === "apply" || alert.action === "dry-run")
        }
        onConfirm={handleAlertConfirm}
        onCancel={handleAlertCancel}
        onClose={closeAlert}
      />
    </div>
  );
}

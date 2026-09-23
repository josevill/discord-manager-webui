import { useState } from "react";
import type {
  ConfigAutoModRule,
  ConfigCategory,
  ConfigChannel,
  ConfigEmoji,
  ConfigOverwrite,
  ConfigRole,
  ConfigWebhook,
  MetaResponse,
  Selection,
  ServerConfig,
} from "../types.js";
import { colorToHex, hexToNumber, permissionValueToFlags } from "../utils.js";
import { AssetPicker } from "./AssetPicker.js";

function PermissionsEditor({
  value,
  flags,
  onChange,
}: {
  value: string | number | string[] | undefined;
  flags: string[];
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(permissionValueToFlags(value));
  return (
    <div className="perm-grid" data-testid="permissions-editor">
      {flags.map((flag) => (
        <label key={flag}>
          <input
            type="checkbox"
            checked={selected.has(flag)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(flag);
              else next.delete(flag);
              onChange([...next]);
            }}
          />
          {flag}
        </label>
      ))}
    </div>
  );
}

function OverwritesEditor({
  overwrites,
  roleNames,
  flags,
  onChange,
}: {
  overwrites: ConfigOverwrite[];
  roleNames: string[];
  flags: string[];
  onChange: (next: ConfigOverwrite[]) => void;
}) {
  return (
    <div data-testid="overwrites-editor">
      {overwrites.map((ow, i) => (
        <div key={i} className="overwrite-card">
          <div className="field">
            <label>Role</label>
            <select
              value={ow.role}
              onChange={(e) => {
                const next = [...overwrites];
                next[i] = { ...ow, role: e.target.value };
                onChange(next);
              }}
            >
              {[...new Set(["@everyone", ...roleNames, ow.role])].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Allow</label>
            <PermissionsEditor
              value={ow.allow}
              flags={flags}
              onChange={(allow) => {
                const next = [...overwrites];
                next[i] = { ...ow, allow };
                onChange(next);
              }}
            />
          </div>
          <div className="field">
            <label>Deny</label>
            <PermissionsEditor
              value={ow.deny}
              flags={flags}
              onChange={(deny) => {
                const next = [...overwrites];
                next[i] = { ...ow, deny };
                onChange(next);
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onChange(overwrites.filter((_, j) => j !== i))}
          >
            Remove overwrite
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm btn-outline"
        onClick={() =>
          onChange([...overwrites, { role: roleNames[0] ?? "@everyone", allow: [], deny: [] }])
        }
      >
        + Overwrite
      </button>
    </div>
  );
}

const VERIFICATION_LABELS: Record<number, string> = {
  0: "None",
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Very high",
};

const AUTO_MOD_EVENT_OPTIONS: [number, string][] = [
  [1, "Keyword"],
  [2, "Spam"],
  [3, "Mention spam"],
  [4, "Keyword preset"],
  [5, "Pattern"],
  [6, "Character spam"],
  [7, "Auto-block term"],
];

function autoModTriggerOptions(eventType: number): [number, string][] {
  switch (eventType) {
    case 1:
      return [
        [0, "Allowed words"],
        [1, "Marked words"],
        [2, "Regex"],
      ];
    case 4:
      return [[0, "Presets"]];
    case 5:
      return [
        [0, "Mentions"],
        [1, "Keyword"],
        [2, "Regex"],
        [3, "Character spam"],
      ];
    case 7:
      return [[0, "Auto-block term"]];
    default:
      return [[0, "(none)"]];
  }
}

const AUTO_MOD_ACTION_OPTIONS: [number, string][] = [
  [1, "Alert (message in a channel)"],
  [2, "Block message"],
  [3, "Remove message"],
  [4, "Timeout member"],
];

/** Free-form `trigger_metadata` editor: JSON textarea, commits only valid objects. */
function MetadataEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleInput(next: string) {
    setText(next);
    try {
      const parsed: unknown = next.trim() === "" ? {} : JSON.parse(next);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setError(null);
        onChange(parsed as Record<string, unknown>);
      } else {
        setError("Metadata must be a JSON object");
      }
    } catch {
      setError("Invalid JSON — changes not saved");
    }
  }

  return (
    <div className="field">
      <label>Trigger metadata (JSON)</label>
      <textarea
        data-testid="auto-mod-metadata-input"
        className="mono"
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(e) => handleInput(e.target.value)}
      />
      {error ? <span className="field-hint error">{error}</span> : null}
      <span className="field-hint">
        e.g. {'{ "keywords": ["spam"] }'} or {'{ "regex_patterns": ["^\\\\d+@\\\\d+$"] }'}
      </span>
    </div>
  );
}

/** Checkbox list over role/channel names (emoji role restrictions, auto-mod exemptions). */
function NameCheckList({
  names,
  selected,
  onChange,
  testId,
}: {
  names: string[];
  selected: Set<string>;
  onChange: (next: string[]) => void;
  testId: string;
}) {
  return (
    <div className="perm-grid" data-testid={testId}>
      {names.length === 0 ? (
        <span className="field-hint">(none available)</span>
      ) : (
        names.map((name) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={selected.has(name)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(name);
                else next.delete(name);
                onChange([...next]);
              }}
            />
            {name}
          </label>
        ))
      )}
    </div>
  );
}

export function Inspector({
  config,
  selection,
  meta,
  onChange,
  onDelete,
}: {
  config: ServerConfig;
  selection: Selection;
  meta: MetaResponse;
  onChange: (next: ServerConfig) => void;
  onDelete: () => void;
}) {
  const roles = config.roles ?? [];
  const categories = config.categories ?? [];
  const channels = config.channels ?? [];
  const guild = config.guild ?? {};
  const channelNames = channels.map((c) => c.name);

  if (!selection) {
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">Inspector</div>
        <div className="empty-state">Select a role, category, or channel to edit its fields.</div>
      </aside>
    );
  }

  if (selection.kind === "guild") {
    const patchGuild = (patch: Partial<NonNullable<ServerConfig["guild"]>>) =>
      onChange({ ...config, guild: { ...guild, ...patch } });

    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">Guild settings</div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Identity</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="guild-name-input"
                value={guild.name ?? ""}
                onChange={(e) => patchGuild({ name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Description</label>
              <textarea
                value={guild.description ?? ""}
                onChange={(e) => patchGuild({ description: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>Preferred locale</label>
              <input
                value={guild.preferred_locale ?? ""}
                placeholder="en-US"
                onChange={(e) => patchGuild({ preferred_locale: e.target.value })}
              />
            </div>
          </div>

          <div className="inspector-section">
            <h3 className="inspector-section-title">Branding</h3>
            <div className="field">
              <label>Icon</label>
              <AssetPicker value={guild.icon} onChange={(icon) => patchGuild({ icon })} />
            </div>
            <div className="field">
              <label>Banner</label>
              <AssetPicker value={guild.banner} onChange={(banner) => patchGuild({ banner })} />
            </div>
            <div className="field">
              <label>Splash</label>
              <AssetPicker value={guild.splash} onChange={(splash) => patchGuild({ splash })} />
            </div>
          </div>

          <div className="inspector-section">
            <h3 className="inspector-section-title">Moderation</h3>
            <div className="field">
              <label>Verification level</label>
              <select
                value={guild.verification_level ?? 0}
                onChange={(e) => patchGuild({ verification_level: Number(e.target.value) })}
              >
                {[0, 1, 2, 3, 4].map((v) => (
                  <option key={v} value={v}>
                    {v} - {VERIFICATION_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Default notifications</label>
              <select
                value={guild.default_message_notifications ?? 0}
                onChange={(e) =>
                  patchGuild({
                    default_message_notifications: Number(e.target.value),
                  })
                }
              >
                <option value={0}>All messages</option>
                <option value={1}>Only mentions</option>
              </select>
            </div>
            <div className="field">
              <label>Explicit content filter</label>
              <select
                value={guild.explicit_content_filter ?? 0}
                onChange={(e) =>
                  patchGuild({
                    explicit_content_filter: Number(e.target.value),
                  })
                }
              >
                <option value={0}>Disabled</option>
                <option value={1}>Members without roles</option>
                <option value={2}>All members</option>
              </select>
            </div>
          </div>

          <div className="inspector-section">
            <h3 className="inspector-section-title">System channels</h3>
            <div className="field">
              <label>System channel</label>
              <input
                list="channel-options"
                value={guild.system_channel ?? ""}
                placeholder="(none)"
                onChange={(e) => patchGuild({ system_channel: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>Rules channel</label>
              <input
                list="channel-options"
                value={guild.rules_channel ?? ""}
                placeholder="(none)"
                onChange={(e) => patchGuild({ rules_channel: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>Public updates channel</label>
              <input
                list="channel-options"
                value={guild.public_updates_channel ?? ""}
                placeholder="(none)"
                onChange={(e) =>
                  patchGuild({
                    public_updates_channel: e.target.value || null,
                  })
                }
              />
            </div>
            <div className="field">
              <label>AFK channel</label>
              <input
                list="channel-options"
                value={guild.afk_channel ?? ""}
                placeholder="(none)"
                onChange={(e) => patchGuild({ afk_channel: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>AFK timeout (seconds)</label>
              <input
                type="number"
                min={60}
                step={60}
                value={guild.afk_timeout ?? 300}
                onChange={(e) => patchGuild({ afk_timeout: Number(e.target.value) })}
              />
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(guild.premium_progress_bar_enabled)}
                onChange={(e) =>
                  patchGuild({
                    premium_progress_bar_enabled: e.target.checked,
                  })
                }
              />
              Show boost progress bar
            </label>
            <datalist id="channel-options">
              {channelNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "role") {
    const role = roles[selection.index];
    if (!role) return null;
    const update = (patch: Partial<ConfigRole>) => {
      const next = [...roles];
      next[selection.index] = { ...role, ...patch };
      onChange({ ...config, roles: next });
    };
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">
          <span>Role</span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            data-testid="delete-selection"
          >
            Delete
          </button>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Basics</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="role-name-input"
                value={role.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Color</label>
              <input
                type="color"
                data-testid="role-color-input"
                value={colorToHex(role.color)}
                onChange={(e) => update({ color: hexToNumber(e.target.value) })}
              />
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(role.hoist)}
                onChange={(e) => update({ hoist: e.target.checked })}
              />
              Display role members separately (hoist)
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(role.mentionable)}
                onChange={(e) => update({ mentionable: e.target.checked })}
              />
              Mentionable
            </label>
            <div className="field">
              <label>Unicode emoji (shown before members in the member list)</label>
              <input
                data-testid="role-emoji-input"
                value={role.unicode_emoji ?? ""}
                placeholder="e.g. 🛡️"
                onChange={(e) => update({ unicode_emoji: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>Icon</label>
              <AssetPicker value={role.icon} onChange={(icon) => update({ icon })} />
            </div>
          </div>
          <div className="inspector-section">
            <h3 className="inspector-section-title">Permissions</h3>
            <PermissionsEditor
              value={role.permissions}
              flags={meta.permissionFlags}
              onChange={(permissions) => update({ permissions })}
            />
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "category") {
    const cat = categories[selection.index];
    if (!cat) return null;
    const update = (patch: Partial<ConfigCategory>) => {
      const next = [...categories];
      const prevName = cat.name;
      const updated = { ...cat, ...patch };
      next[selection.index] = updated;
      let nextChannels = channels;
      if (patch.name !== undefined && patch.name !== prevName) {
        nextChannels = channels.map((ch) =>
          ch.category === prevName ? { ...ch, category: patch.name! } : ch,
        );
      }
      onChange({ ...config, categories: next, channels: nextChannels });
    };
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">
          <span>Category</span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            data-testid="delete-selection"
          >
            Delete
          </button>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Basics</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="category-name-input"
                value={cat.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
          </div>
          <div className="inspector-section">
            <h3 className="inspector-section-title">Permission overwrites</h3>
            <OverwritesEditor
              overwrites={cat.permission_overwrites ?? []}
              roleNames={roles.map((r) => r.name)}
              flags={meta.permissionFlags}
              onChange={(permission_overwrites) => update({ permission_overwrites })}
            />
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "emoji") {
    const emojis = config.emojis ?? [];
    const emoji = emojis[selection.index];
    if (!emoji) return null;
    const update = (patch: Partial<ConfigEmoji>) => {
      const next = [...emojis];
      next[selection.index] = { ...emoji, ...patch };
      onChange({ ...config, emojis: next });
    };
    const roleNames = roles.map((r) => r.name).filter((n) => n !== "@everyone");
    const selectedRoles = new Set(emoji.roles ?? []);
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">
          <span>Emoji</span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            data-testid="delete-selection"
          >
            Delete
          </button>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Basics</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="emoji-name-input"
                value={emoji.name}
                onChange={(e) => update({ name: e.target.value.replace(/\s+/g, "_") })}
              />
              <span className="field-hint">Alphanumeric + underscore, 2–32 characters</span>
            </div>
            <div className="field">
              <label>Image</label>
              <AssetPicker
                value={emoji.image}
                allowClear={false}
                onChange={(image) => {
                  if (image) update({ image });
                }}
              />
            </div>
            <div className="field">
              <label>Role-restricted (visible only to members with these roles)</label>
              <NameCheckList
                names={roleNames}
                selected={selectedRoles}
                onChange={(roles) => update({ roles })}
                testId="emoji-roles-editor"
              />
            </div>
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "webhook") {
    const webhooks = config.webhooks ?? [];
    const wh = webhooks[selection.index];
    if (!wh) return null;
    const update = (patch: Partial<ConfigWebhook>) => {
      const next = [...webhooks];
      next[selection.index] = { ...wh, ...patch };
      onChange({ ...config, webhooks: next });
    };
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">
          <span>Webhook</span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            data-testid="delete-selection"
          >
            Delete
          </button>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Basics</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="webhook-name-input"
                value={wh.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Channel (where the webhook posts)</label>
              <input
                list="webhook-channel-options"
                data-testid="webhook-channel-input"
                value={wh.channel}
                onChange={(e) => update({ channel: e.target.value })}
              />
              <datalist id="webhook-channel-options">
                {channelNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label>Avatar</label>
              <AssetPicker value={wh.avatar} onChange={(avatar) => update({ avatar })} />
            </div>
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "autoMod") {
    const rules = config.auto_mod?.rules ?? [];
    const rule = rules[selection.index];
    if (!rule) return null;
    const update = (patch: Partial<ConfigAutoModRule>) => {
      const next = [...rules];
      next[selection.index] = { ...rule, ...patch };
      onChange({ ...config, auto_mod: { rules: next } });
    };
    const setActionMeta = (ai: number, patch: Record<string, unknown>) => {
      const current = rule.actions[ai];
      if (!current) return;
      const next = [...rule.actions];
      next[ai] = { ...current, metadata: { ...current.metadata, ...patch } };
      update({ actions: next });
    };
    const roleNames = roles.map((r) => r.name);
    const exemptRoles = new Set(rule.exempt_roles ?? []);
    const exemptChannels = new Set(rule.exempt_channels ?? []);
    return (
      <aside className="panel panel-inspector" data-testid="inspector">
        <div className="panel-header">
          <span>Auto-mod rule</span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            data-testid="delete-selection"
          >
            Delete
          </button>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <h3 className="inspector-section-title">Basics</h3>
            <div className="field">
              <label>Name</label>
              <input
                data-testid="auto-mod-name-input"
                value={rule.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={rule.enabled !== false}
                onChange={(e) => update({ enabled: e.target.checked })}
                data-testid="auto-mod-enabled-input"
              />
              Enabled
            </label>
            <div className="field">
              <label>Event type</label>
              <select
                data-testid="auto-mod-event-input"
                value={rule.event_type}
                onChange={(e) => {
                  const eventType = Number(e.target.value);
                  const triggerOptions = autoModTriggerOptions(eventType);
                  const triggerType = triggerOptions.some(([v]) => v === rule.trigger_type)
                    ? rule.trigger_type
                    : (triggerOptions[0]?.[0] ?? 0);
                  update({ event_type: eventType, trigger_type: triggerType });
                }}
              >
                {AUTO_MOD_EVENT_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Trigger type</label>
              <select
                data-testid="auto-mod-trigger-input"
                value={rule.trigger_type}
                onChange={(e) => update({ trigger_type: Number(e.target.value) })}
              >
                {autoModTriggerOptions(rule.event_type).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <MetadataEditor
              key={selection.index}
              value={rule.trigger_metadata}
              onChange={(trigger_metadata) => update({ trigger_metadata })}
            />
          </div>

          <div className="inspector-section">
            <h3 className="inspector-section-title">Actions</h3>
            {rule.actions.map((action, ai) => (
              <div key={ai} className="overwrite-card" data-testid={`auto-mod-action-${ai}`}>
                <div className="field-row">
                  <select
                    data-testid={`auto-mod-action-type-${ai}`}
                    value={action.type}
                    onChange={(e) => {
                      const next = [...rule.actions];
                      next[ai] = { type: Number(e.target.value) };
                      update({ actions: next });
                    }}
                  >
                    {AUTO_MOD_ACTION_OPTIONS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      const next = rule.actions.filter((_, j) => j !== ai);
                      if (next.length > 0) update({ actions: next });
                    }}
                    data-testid={`auto-mod-remove-action-${ai}`}
                  >
                    Remove
                  </button>
                </div>
                {action.type === 1 ? (
                  <>
                    <div className="field">
                      <label>Alert channel</label>
                      <input
                        list="auto-mod-action-channel-options"
                        data-testid={`auto-mod-action-channel-${ai}`}
                        value={action.metadata?.channel ?? ""}
                        onChange={(e) =>
                          setActionMeta(ai, {
                            channel: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Custom message (optional)</label>
                      <input
                        data-testid={`auto-mod-action-message-${ai}`}
                        value={action.metadata?.custom_message ?? ""}
                        onChange={(e) =>
                          setActionMeta(ai, {
                            custom_message: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  </>
                ) : null}
                {action.type === 4 ? (
                  <>
                    <div className="field">
                      <label>Timeout duration (seconds)</label>
                      <input
                        type="number"
                        min={60}
                        step={60}
                        data-testid={`auto-mod-action-duration-${ai}`}
                        value={action.metadata?.duration_seconds ?? 600}
                        onChange={(e) =>
                          setActionMeta(ai, { duration_seconds: Number(e.target.value) })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Reason (optional)</label>
                      <input
                        data-testid={`auto-mod-action-message-${ai}`}
                        value={action.metadata?.custom_message ?? ""}
                        onChange={(e) =>
                          setActionMeta(ai, {
                            custom_message: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => update({ actions: [...rule.actions, { type: 2 }] })}
              data-testid="auto-mod-add-action"
            >
              + Action
            </button>
            <datalist id="auto-mod-action-channel-options">
              {channelNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="inspector-section">
            <h3 className="inspector-section-title">Exemptions</h3>
            <div className="field">
              <label>Exempt roles</label>
              <NameCheckList
                names={roleNames}
                selected={exemptRoles}
                onChange={(exempt_roles) => update({ exempt_roles })}
                testId="auto-mod-exempt-roles"
              />
            </div>
            <div className="field">
              <label>Exempt channels</label>
              <NameCheckList
                names={channelNames}
                selected={exemptChannels}
                onChange={(exempt_channels) => update({ exempt_channels })}
                testId="auto-mod-exempt-channels"
              />
            </div>
          </div>
        </div>
      </aside>
    );
  }

  const channel = channels[selection.index];
  if (!channel) return null;
  const update = (patch: Partial<ConfigChannel>) => {
    const next = [...channels];
    next[selection.index] = { ...channel, ...patch };
    onChange({ ...config, channels: next });
  };
  const isVoiceLike = channel.type === "voice" || channel.type === "stage";

  return (
    <aside className="panel panel-inspector" data-testid="inspector">
      <div className="panel-header">
        <span>Channel</span>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onDelete}
          data-testid="delete-selection"
        >
          Delete
        </button>
      </div>
      <div className="inspector-body">
        <div className="inspector-section">
          <h3 className="inspector-section-title">Basics</h3>
          <div className="field">
            <label>Name</label>
            <input
              data-testid="channel-name-input"
              value={channel.name}
              onChange={(e) =>
                update({
                  name: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                })
              }
            />
          </div>
          <div className="field">
            <label>Type</label>
            <select
              data-testid="channel-type-input"
              value={channel.type ?? "text"}
              onChange={(e) => update({ type: e.target.value as ConfigChannel["type"] })}
            >
              {meta.channelTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Category</label>
            <input
              list="category-options"
              data-testid="channel-category-input"
              value={channel.category ?? ""}
              placeholder="(none)"
              onChange={(e) => update({ category: e.target.value || null })}
            />
            <datalist id="category-options">
              {categories.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </div>
          {!isVoiceLike ? (
            <div className="field">
              <label>Topic</label>
              <textarea
                data-testid="channel-topic-input"
                value={channel.topic ?? ""}
                onChange={(e) => update({ topic: e.target.value || null })}
              />
            </div>
          ) : null}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(channel.nsfw)}
              onChange={(e) => update({ nsfw: e.target.checked })}
            />
            NSFW
          </label>
          {!isVoiceLike ? (
            <div className="field">
              <label>Slowmode (seconds)</label>
              <input
                type="number"
                min={0}
                value={channel.slowmode ?? 0}
                onChange={(e) => update({ slowmode: Number(e.target.value) })}
              />
            </div>
          ) : null}
        </div>

        {isVoiceLike ? (
          <div className="inspector-section">
            <h3 className="inspector-section-title">Voice</h3>
            <div className="field">
              <label>Bitrate</label>
              <input
                type="number"
                min={8000}
                step={1000}
                value={channel.bitrate ?? 64000}
                onChange={(e) => update({ bitrate: Number(e.target.value) })}
              />
              <span className="field-hint">Discord range is typically 8kbps-384kbps</span>
            </div>
            <div className="field">
              <label>User limit</label>
              <input
                type="number"
                min={0}
                value={channel.user_limit ?? 0}
                onChange={(e) => update({ user_limit: Number(e.target.value) })}
              />
              <span className="field-hint">0 means unlimited</span>
            </div>
            <div className="field">
              <label>RTC region</label>
              <input
                value={channel.rtc_region ?? ""}
                placeholder="auto"
                onChange={(e) => update({ rtc_region: e.target.value || null })}
              />
            </div>
          </div>
        ) : null}

        <div className="inspector-section">
          <h3 className="inspector-section-title">Permission overwrites</h3>
          <OverwritesEditor
            overwrites={channel.permission_overwrites ?? []}
            roleNames={roles.map((r) => r.name)}
            flags={meta.permissionFlags}
            onChange={(permission_overwrites) => update({ permission_overwrites })}
          />
        </div>
      </div>
    </aside>
  );
}

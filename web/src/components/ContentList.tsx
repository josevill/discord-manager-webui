import { Lightning, Megaphone, Smiley } from "@phosphor-icons/react";
import type { ConfigAutoModRule, ConfigEmoji, ConfigWebhook, Selection } from "../types.js";

function SectionHeader({
  icon,
  label,
  onAdd,
  addTestId,
}: {
  icon: React.ReactNode;
  label: string;
  onAdd: () => void;
  addTestId: string;
}) {
  return (
    <div className="content-section-header">
      <span className="content-section-label">
        {icon}
        {label}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onAdd}
        data-testid={addTestId}
      >
        + Add
      </button>
    </div>
  );
}

/**
 * Lists the config domains that are not part of the role/channel tree:
 * emojis, webhooks, and auto-mod rules. Selecting an item opens its form
 * card in the Inspector.
 */
export function ContentList({
  emojis,
  webhooks,
  autoModRules,
  selection,
  onSelect,
  onAddEmoji,
  onAddWebhook,
  onAddAutoModRule,
}: {
  emojis: ConfigEmoji[];
  webhooks: ConfigWebhook[];
  autoModRules: ConfigAutoModRule[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onAddEmoji: () => void;
  onAddWebhook: () => void;
  onAddAutoModRule: () => void;
}) {
  const isSelected = (kind: "emoji" | "webhook" | "autoMod", index: number) =>
    selection?.kind === kind && selection.index === index;

  return (
    <aside className="panel" data-testid="content-list">
      <div className="panel-header">
        <span>Content</span>
      </div>
      <div className="panel-body">
        <div className="content-section">
          <SectionHeader
            icon={<Smiley size={13} aria-hidden />}
            label="Emojis"
            onAdd={onAddEmoji}
            addTestId="add-emoji"
          />
          {emojis.map((emoji, index) => (
            <button
              key={`${emoji.name}-${index}`}
              type="button"
              className={`list-item${isSelected("emoji", index) ? " active" : ""}`}
              onClick={() => onSelect({ kind: "emoji", index })}
              data-testid={`emoji-item-${emoji.name}`}
            >
              <span className="content-item-name">{emoji.name}</span>
              {(emoji.roles ?? []).length > 0 ? (
                <span className="badge">{(emoji.roles ?? []).length} roles</span>
              ) : null}
            </button>
          ))}
          {emojis.length === 0 ? <div className="content-empty">No emojis.</div> : null}
        </div>

        <div className="content-section">
          <SectionHeader
            icon={<Megaphone size={13} aria-hidden />}
            label="Webhooks"
            onAdd={onAddWebhook}
            addTestId="add-webhook"
          />
          {webhooks.map((wh, index) => (
            <button
              key={`${wh.name}-${index}`}
              type="button"
              className={`list-item${isSelected("webhook", index) ? " active" : ""}`}
              onClick={() => onSelect({ kind: "webhook", index })}
              data-testid={`webhook-item-${wh.name}`}
            >
              <span className="content-item-name">{wh.name}</span>
              <span className="badge" title={`Posts to #${wh.channel}`}>
                {wh.channel}
              </span>
            </button>
          ))}
          {webhooks.length === 0 ? <div className="content-empty">No webhooks.</div> : null}
        </div>

        <div className="content-section">
          <SectionHeader
            icon={<Lightning size={13} aria-hidden />}
            label="Auto-mod rules"
            onAdd={onAddAutoModRule}
            addTestId="add-auto-mod-rule"
          />
          {autoModRules.map((rule, index) => (
            <button
              key={`${rule.name}-${index}`}
              type="button"
              className={`list-item${isSelected("autoMod", index) ? " active" : ""}`}
              onClick={() => onSelect({ kind: "autoMod", index })}
              data-testid={`auto-mod-item-${rule.name}`}
            >
              <span className="content-item-name">{rule.name}</span>
              {rule.enabled === false ? <span className="badge muted">off</span> : null}
            </button>
          ))}
          {autoModRules.length === 0 ? <div className="content-empty">No rules.</div> : null}
        </div>
      </div>
    </aside>
  );
}

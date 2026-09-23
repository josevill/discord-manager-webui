import { parsePermissionInput } from "../discord/permissions.js";
import type { ServerConfig } from "./schema.js";

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateCrossReferences(config: ServerConfig): ValidationResult {
  const issues: ValidationIssue[] = [];
  const roleNames = new Set(config.roles.map((r) => r.name));
  const categoryNames = new Set(config.categories.map((c) => c.name));
  const channelNames = new Set(config.channels.map((c) => c.name));

  // Duplicate role names
  const roleSeen = new Set<string>();
  for (const role of config.roles) {
    if (roleSeen.has(role.name)) {
      issues.push({
        level: "error",
        path: `roles.${role.name}`,
        message: `Duplicate role name "${role.name}"`,
      });
    }
    roleSeen.add(role.name);

    if (role.permissions !== undefined) {
      try {
        const bits = parsePermissionInput(role.permissions);
        if (bits < 0n || bits > (1n << 64n) - 1n) {
          issues.push({
            level: "error",
            path: `roles.${role.name}.permissions`,
            message: "Permission bitfield out of 64-bit range",
          });
        }
      } catch (e) {
        issues.push({
          level: "error",
          path: `roles.${role.name}.permissions`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const catSeen = new Set<string>();
  for (const cat of config.categories) {
    if (catSeen.has(cat.name)) {
      issues.push({
        level: "error",
        path: `categories.${cat.name}`,
        message: `Duplicate category name "${cat.name}"`,
      });
    }
    catSeen.add(cat.name);
    validateOverwrites(issues, `categories.${cat.name}`, cat.permission_overwrites, roleNames);
  }

  const channelKeySeen = new Set<string>();
  const channelNameOwners = new Map<string, string>();
  for (const ch of config.channels) {
    const catLabel = ch.category ?? "(none)";
    const key = `${catLabel}/${ch.name}`;
    if (channelKeySeen.has(key)) {
      issues.push({
        level: "error",
        path: `channels.${ch.name}`,
        message: `Duplicate channel "${ch.name}" in category "${catLabel}"`,
      });
    }
    channelKeySeen.add(key);

    // Channel identity is name-only (__resolve_channel__), so a name shared
    // across categories makes webhook/auto-mod/welcome refs ambiguous.
    const owner = channelNameOwners.get(ch.name);
    if (owner !== undefined && owner !== catLabel) {
      issues.push({
        level: "error",
        path: `channels.${ch.name}`,
        message: `Channel name "${ch.name}" is defined in both "${owner}" and "${catLabel}"; channel names must be unique across categories`,
      });
    }
    channelNameOwners.set(ch.name, catLabel);

    if (ch.category && !categoryNames.has(ch.category)) {
      issues.push({
        level: "error",
        path: `channels.${ch.name}.category`,
        message: `Category "${ch.category}" is not defined in categories`,
      });
    }
    validateOverwrites(issues, `channels.${ch.name}`, ch.permission_overwrites, roleNames);
  }

  // Guild channel references (system/rules/public-updates/afk) must name a defined channel
  const guildChannelRefs: [string, string | null | undefined][] = [
    ["system_channel", config.guild.system_channel],
    ["rules_channel", config.guild.rules_channel],
    ["public_updates_channel", config.guild.public_updates_channel],
    ["afk_channel", config.guild.afk_channel],
  ];
  for (const [field, name] of guildChannelRefs) {
    if (name && !channelNames.has(name)) {
      issues.push({
        level: "error",
        path: `guild.${field}`,
        message: `Channel "${name}" is not defined in channels`,
      });
    }
  }

  for (const emoji of config.emojis) {
    for (const role of emoji.roles) {
      if (!roleNames.has(role) && role !== "@everyone") {
        issues.push({
          level: "error",
          path: `emojis.${emoji.name}.roles`,
          message: `Role "${role}" is not defined`,
        });
      }
    }
  }

  for (const wh of config.webhooks) {
    if (!channelNames.has(wh.channel)) {
      issues.push({
        level: "error",
        path: `webhooks.${wh.name}.channel`,
        message: `Channel "${wh.channel}" is not defined`,
      });
    }
  }

  for (const rule of config.auto_mod.rules) {
    for (const action of rule.actions) {
      if (action.metadata?.channel && !channelNames.has(action.metadata.channel)) {
        issues.push({
          level: "error",
          path: `auto_mod.rules.${rule.name}.actions`,
          message: `Channel "${action.metadata.channel}" is not defined`,
        });
      }
    }
    for (const role of rule.exempt_roles) {
      if (!roleNames.has(role) && role !== "@everyone") {
        issues.push({
          level: "error",
          path: `auto_mod.rules.${rule.name}.exempt_roles`,
          message: `Role "${role}" is not defined`,
        });
      }
    }
    for (const ch of rule.exempt_channels) {
      if (!channelNames.has(ch)) {
        issues.push({
          level: "error",
          path: `auto_mod.rules.${rule.name}.exempt_channels`,
          message: `Channel "${ch}" is not defined`,
        });
      }
    }
  }

  if (config.welcome_screen) {
    for (const wc of config.welcome_screen.welcome_channels) {
      if (!channelNames.has(wc.channel)) {
        issues.push({
          level: "error",
          path: "welcome_screen.welcome_channels",
          message: `Channel "${wc.channel}" is not defined`,
        });
      }
    }
  }

  if (config.onboarding) {
    for (const ch of config.onboarding.default_channel_ids) {
      if (!channelNames.has(ch)) {
        issues.push({
          level: "error",
          path: "onboarding.default_channel_ids",
          message: `Channel "${ch}" is not defined`,
        });
      }
    }
    for (const [pi, prompt] of config.onboarding.prompts.entries()) {
      for (const [oi, opt] of prompt.options.entries()) {
        for (const ch of opt.channel_ids) {
          if (!channelNames.has(ch)) {
            issues.push({
              level: "error",
              path: `onboarding.prompts[${pi}].options[${oi}].channel_ids`,
              message: `Channel "${ch}" is not defined`,
            });
          }
        }
        for (const role of opt.role_ids) {
          if (!roleNames.has(role) && role !== "@everyone") {
            issues.push({
              level: "error",
              path: `onboarding.prompts[${pi}].options[${oi}].role_ids`,
              message: `Role "${role}" is not defined`,
            });
          }
        }
      }
    }
  }

  if (config.widget?.channel && !channelNames.has(config.widget.channel)) {
    issues.push({
      level: "error",
      path: "widget.channel",
      message: `Channel "${config.widget.channel}" is not defined`,
    });
  }

  for (const field of [
    "afk_channel",
    "system_channel",
    "rules_channel",
    "public_updates_channel",
  ] as const) {
    const value = config.guild[field];
    if (value && !channelNames.has(value)) {
      issues.push({
        level: "error",
        path: `guild.${field}`,
        message: `Channel "${value}" is not defined`,
      });
    }
  }

  const needsCommunity =
    Boolean(config.welcome_screen) ||
    Boolean(config.onboarding) ||
    config.channels.some((c) => c.type === "announcement");
  if (needsCommunity) {
    issues.push({
      level: "warning",
      path: "guild",
      message:
        "Config uses Community features (welcome/onboarding/announcement). The guild must have COMMUNITY enabled.",
    });
  }

  if (config.vanity_url_code) {
    issues.push({
      level: "warning",
      path: "vanity_url_code",
      message: "Vanity URL requires boost level 3; will be skipped if tier is insufficient.",
    });
  }

  const errors = issues.filter((i) => i.level === "error");
  return { ok: errors.length === 0, issues };
}

function validateOverwrites(
  issues: ValidationIssue[],
  path: string,
  overwrites: { role: string; allow?: unknown; deny?: unknown }[] | undefined,
  roleNames: Set<string>,
): void {
  if (!overwrites) return;
  for (const ow of overwrites) {
    if (ow.role !== "@everyone" && !roleNames.has(ow.role)) {
      issues.push({
        level: "error",
        path: `${path}.permission_overwrites`,
        message: `Role "${ow.role}" is not defined`,
      });
    }
    for (const field of ["allow", "deny"] as const) {
      const val = ow[field];
      if (val === undefined) continue;
      try {
        parsePermissionInput(val as string | string[]);
      } catch (e) {
        issues.push({
          level: "error",
          path: `${path}.permission_overwrites.${ow.role}.${field}`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

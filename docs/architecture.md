# Architecture

## Pipeline

```
Config (YAML/JSON) ──► validate ──► DesiredState
                                      │
Live Guild ──► StateFetcher ──► GuildState
                                      │
                              Differ / Planner
                                      │
                                 ActionPlan
                                      │
                         Executor (rate-limited REST)
                                      │
                                 Discord API v10
```

## Reconciliation order

1. Guild settings  
2. Roles (create/update; `role_positions` batch only when the hierarchy differs)  
3. Categories  
4. Channels (field diffs; overwrites diffed against live)  
5. Permission overwrites (embedded on channel create/update)  
6. Emojis  
7. Stickers (create/update text fields; image is immutable)  
8. Webhooks  
9. Auto-mod rules  
10. Welcome screen & onboarding (Community required)  
11. Widget & vanity URL (boost-gated)  
12. `channel_positions` batch per parent (full ordering snapshot, emitted last so it sees post-move parents)  
13. Guild channel references (`system_channel`, `rules_channel`, … after channels are resolvable)

## Identity resolution

| Resource | Match key | Fallback |
|----------|-----------|----------|
| Role | `name` | — (`@everyone` is UPDATE-only) |
| Category | `name` + type 4 | — |
| Channel | `name` + parent category | `name` alone (parent change = UPDATE) |
| Emoji | `name` | — |
| Sticker | `name` (guild sticker list) | — |
| Webhook | `name` + channel | `name` alone |
| Auto-mod | `name` | — |

Managed roles (`managed: true`) are never matched for mutate/delete.

## ActionPlan

Each action: `CREATE | UPDATE | DELETE | SKIP` with `domain`, `resource`, `endpoint`, `method`, `payload`, `reason`, `dependencies`, optional `targetId` / `skipReason`.

Placeholders resolved at execute time:

- `__resolve_role__:Name`
- `__resolve_category__:Name`
- `__resolve_channel__:Name`
- `__asset__:./path.png` → `data:` URI (local paths, `data:` URIs, and `http(s)` URLs — URLs are downloaded; the bot token goes only to Discord CDN hosts). Sticker CREATE bypasses the JSON path and uploads via `multipart/form-data`.

## Watch modes

- **File watcher** (default): chokidar, 500ms debounce → re-apply  
- **`--interval N`**: poll full state every N seconds  
- **`--gateway`**: advisory drift logs only (no auto-revert in v1). Loads the
  optional `discord.js` dependency lazily (dynamic import) so it stays out of
  every non-gateway run; a friendly error tells you to `npm install discord.js`
  when it is missing.

## Known limitations (v1)

- **Gateway drift monitoring is advisory only.** `watch --gateway` logs
  out-of-band drift events (channel/role/emoji/webhook create/update/delete)
  but does not reconcile or revert them. Convergence happens on the next
  file-change or interval reconcile.
- **Permission overwrites merge, they do not replace.** Discord's channel
  PATCH merges overwrite entries, so apply never sends "delete everything not
  in config". Live overwrites on roles **not** in the config are treated as
  out-of-band and left alone (no perpetual diff). When a config-defined
  role's overwrite is **removed** from the config, apply emits an explicit
  zeroed overwrite (`allow: "0"`, `deny: "0"`) so Discord actually deletes it
  — that does remove the permission grant/deny.
- **Name-based identity, no multi-name disambiguation.** Channels are matched
  by `name` within their parent category; duplicate channel names across
  categories are a validation error (there is no `Category/name` reference
  syntax in v1). Roles, emojis, webhooks, and auto-mod rules are matched by
  name only. `@everyone` is update-only (never created or deleted).
- **Sticker images are immutable on Discord.** A sticker-image mismatch
  surfaces as an advisory SKIP — change the image by deleting and
  re-creating the sticker (name identity makes the prune + create converge).
- **State cache, backups, and audit logs are local and manual.**
  `~/.discord-manager/` is not a synced source of truth; the config file is.
  The state cache is surfaced by `discord-manager state`; backups and audit
  logs grow forever unless you pass `--keep N` to `apply`/`watch` (rotation
  is file-level, audit files are never truncated mid-file).
- **WebUI is unauthenticated by design.** It binds to 127.0.0.1 as a local
  companion (no OAuth); re-decide only if the bind host ever moves off loopback.
- **Audit is mutation-only and best-effort on crash.** The JSONL records
  apply runs only (not plan/validate/export); a best-effort `exit` handler
  writes an interrupted `run_end` on clean process exits, but a hard kill
  (SIGKILL/crash) leaves no marker (see implementation-notes, design 14).

## Edge-case matrix

| Case | Behavior |
|------|----------|
| Role above bot | SKIP + warning |
| Managed role name clash | SKIP |
| Delete system/rules/AFK channel | Clear guild refs first, then DELETE |
| Live overwrite on a role not in config | Ignored (out-of-band) — no permanent diff |
| Config-defined role's overwrite removed from config | Explicit zeroed overwrite (`allow: "0"`, `deny: "0"`) so Discord actually deletes it |
| Channel/role ordering drift | Single batch reorder per parent (`PATCH /guilds/:id/channels`, `PATCH /guilds/:id/roles`) with a complete 0..n-1 snapshot; no per-channel position churn |
| Guild icon/banner/splash unchanged (sha1 matches live hash) | No re-upload |
| `http(s)`-valued asset field | Downloaded at plan time (hashed) and at apply time (uploaded); token only to Discord CDN hosts |
| Sticker image differs from config file | Advisory SKIP — Discord cannot PATCH a sticker image; delete + re-create to change it |
| Vanity without boost 3 | SKIP |
| Welcome/onboarding without COMMUNITY | SKIP |
| Permissions | Always `bigint` / string — never `Number` |
| Deletes | Confirm unless `--yes`; refuse in non-TTY without `--yes` |
| Apply | JSONL backup under `~/.discord-manager/backups/`; mutation audit under `~/.discord-manager/audit/<guildId>.jsonl` |
| Export / WebUI Fetch | Emoji/sticker/guild-asset images downloaded to `<config dir>/assets/`; config rewritten to relative paths so the export re-applies |

**Idempotency contract:** a second `plan` against an unchanged config produces
zero non-SKIP actions. `tests/integration/reconcile.test.ts` enforces this
(plan → execute against a Discord-semantics mock → re-plan → no-op).

# Implementation notes

## Module map

| Path | Role |
|------|------|
| `src/cli.ts` | Commander entry |
| `src/config/schema.ts` | Zod config schema |
| `src/config/loader.ts` | YAML/JSON load |
| `src/config/validate.ts` | Cross-reference preflight |
| `src/discord/client.ts` | REST wrapper + `fetchGuildState` |
| `src/discord/rate-limit.ts` | Bucket/global 429 handling |
| `src/discord/permissions.ts` | Flag ↔ bigint |
| `src/reconcile/diff.ts` | Per-domain diff |
| `src/reconcile/plan.ts` | Ordered ActionPlan |
| `src/reconcile/execute.ts` | Apply + placeholder resolution |
| `src/reconcile/identity.ts` | Name matching |
| `src/reconcile/resolved.ts` | Seed ID map from live state |
| `src/state/*` | Types, backup, audit, export |
| `src/watch/*` | File watcher + drift helpers |
| `src/commands/*` | CLI command handlers |
| `src/web/server.ts` | Local WebUI HTTP API (Hono) |
| `web/` | Vite + React visual config builder |

## Design choices (v1)

1. **TypeScript ESM + discord.js REST** for mutations; Gateway only for advisory watch.  
2. **No SQLite** — JSON state/backups/audit under `~/.discord-manager/`.  
3. **Advisory Gateway drift** — log only; corrective mode deferred.  
4. **Permissions as strings/bigint** — avoid JS Number precision issues.  
5. **Prune opt-in** (`--prune`) — default apply never deletes unknown resources.  
6. **Member role assignments** deferred (not a first-class config block beyond onboarding refs).  
7. **Coverage gate** focuses on schema/identity/plan/permissions; full diff surface covered by targeted unit + E2E.  
8. **Idempotency is a tested contract** — `tests/integration/reconcile.test.ts` replans after a mock apply and asserts zero non-SKIP actions.  
9. **Ordering is reconciled by batch actions** (`role_positions`, `channel_positions`) with complete 0..n-1 snapshots; raw `position` is never compared per-channel, which would churn forever under Discord's renumbering.
10. **Assets are diffed by content hash** (sha1 hex of the asset bytes vs. the live asset hash: guild icon/banner/splash, role `icon`, webhook `avatar`). For emoji and sticker images the API exposes no hash, so `fetchGuildState` downloads each image from the CDN (emoji: auth-gated `cdn.discordapp.com`, concurrency 8; stickers: unauthenticated `media.discordapp.net`) and stores the bytes' sha1 as `imageHash`. `http(s)://`-valued config assets are downloaded + hashed at plan time (`urlAssetHashesFor`) and downloaded again at apply time by the executor (token only to Discord-owned hosts), so URL assets diff and upload like local files. When a hash cannot be computed on either side (download failed, missing file), the asset is **assumed unchanged** — re-uploading could never converge, so assuming equality is what keeps apply idempotent.
11. **Stickers: name identity, image immutable.** CREATE is a `multipart/form-data` upload (Discord rejects JSON with 50035; the executor special-cases `domain === "sticker"` + POST and builds the `FormData` from the resolved `__asset__:` bytes). name/description/tags are PATCHed on drift. A sticker's image cannot be changed by any API call — a hash mismatch surfaces as an advisory SKIP (delete + re-create changes the sticker id, so the engine never does it automatically). Prune deletes name-absent guild stickers. Bot-created stickers come back as `type: 2` in the guild list but are fully bot-manageable, so no type filtering is needed.
12. **Export round-trips.** `materializeExportAssets` (CLI `export`, WebUI `/api/fetch`) downloads emoji/sticker/guild-icon images into `<config dir>/assets/` and rewrites the config to relative `assets/…` paths (plus guild `icon`/`banner`/`splash`, which `stateToConfig` used to omit). Failure policy: emoji keep the auth-gated CDN URL, stickers fall back to the public media-CDN URL, guild assets are left unmanaged — export never hard-fails on an asset.
13. **WebUI apply is an SSE stream.** `POST /api/apply` answers pre-flight problems (missing credentials, bad body, missing `confirm`, concurrent apply, schema/cross-ref errors) as plain JSON, then streams `text/event-stream`: `start` (plan totals), one `action` event per settled plan action (from `onActionResult`), and a terminal `done` (same payload the old JSON response returned) or `error`. Heartbeat pings every 15 s keep idle proxies from dropping the connection, so long applies no longer sit in one opaque open request. Client disconnect (tab close, or the modal's Cancel button) aborts the fetch; the server maps that to an `AbortSignal` passed to `executePlan`, which stops issuing API calls between actions (an in-flight call is not interrupted) and the run ends with partial counts.
14. **Audit `run_end` survives hard failure.** `createAuditSession` registers a best-effort `process.on("exit")` handler that appends `run_end` with `interrupted: true` if the process exits before the run's `end()` ran (uncaught exception, `process.exit`, SIGTERM — anything that still runs user-space exit hooks). Counts on an interrupted record are partial: `applied`/`failed` reflect actions recorded so far, `skipped` is 0 (skips are never recorded individually). A normal `end()` removes the handler and is idempotent. Hard kills (SIGKILL, segfault) leave no marker — no user-space hook exists for those.

## Known Discord caveats

- Channel names can duplicate across categories — always key by `(name, parent)`.  
- **Overwrites: PATCH is merge, not replace.** The payload only upserts the overwrites it lists. So the diff (a) ignores live overwrites on roles the config does not define, and (b) emits an explicit zeroed overwrite (`allow: "0"`, `deny: "0"`) to delete a config-defined role's overwrite that was removed from config.  
- **Sticker upload is multipart-only** (`POST /guilds/:id/stickers`, `file` part); created stickers report `type: 2` even though they are guild-scoped and bot-deletable. Sticker images are immutable after creation (no PATCH field; the fix is delete + re-create).  
- Community features fail until COMMUNITY is enabled (rules + updates channels).  
- `fetchGuildState` suppresses expected optional-feature misses: welcome screen **10069**, vanity URL **50001** (still warns on other failures).  
- Role hierarchy: bot cannot manage roles at/above its highest role.  
- Bulk apply can 429 — progressive delay mitigates cascading cooldowns.  
- Optimistic concurrency (re-fetch before update) is not fully implemented; watch debounce reduces collision risk.

## Extending

- Add `--corrective` watch mode that re-applies on Gateway events.  
- GitOps: run `plan --json` in CI and `apply --yes` on main.

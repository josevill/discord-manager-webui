## Learned User Preferences

- Prefer a TypeScript CLI for this project over Python or Go.
- Prefer a local companion WebUI (no OAuth / multi-tenant SaaS) with a visual Discord-like builder that still serializes to the same ServerConfig YAML/JSON.
- Prefer short entry points for common workflows (e.g. `ui.ts` / `npm run ui`) over verbose CLI-only invocations.
- Keep the README current when entry points, scripts, or user-facing UX change.
- Prefer mutation-only audit logging as append-only JSONL under `~/.discord-manager/audit/` (not Discord channel posts; not a full plan/validate/export trail).
- Use a disposable test guild for live Discord E2E against the real API.
- Prefer refreshing live Discord guild state into local config (CloudFormation-style baseline) before plan/dry-run/apply so the UI edits against current guild state, not a stale file.
- Prefer the WebUI usable from phone through ultra-wide: adaptive drawers/tabs on small screens, multi-pane on desktop, and hybrid ultra-wide (edge-anchored sidebars with a capped main pane).
- Prefer actionable WebUI status (fetch, plan, dry-run, apply, confirms) in dynamically updating alert modals—not the bottom status bar or native `window.confirm` dialogs.

## Learned Workspace Facts

- This repo is declarative Discord guild IaC: YAML/JSON config → validate / plan / apply via the TypeScript `discord-manager` CLI.
- Runtime state lives under `~/.discord-manager/` (backups and audit); no SQLite.
- The repo is git-versioned (branch `main`) with GitHub Actions CI (`.github/workflows/ci.yml`: typecheck → lint → build → unit+integration + coverage gate → Playwright on push/PR; live E2E is a separate manual/nightly job gated on `DISCORD_TOKEN`/`DISCORD_GUILD_ID`/`E2E_ALLOW_GUILD_ID` secrets) and an ISC `LICENSE`.
- `~/.discord-manager/state/<guildId>.json` (written by export/apply/UI-fetch) is surfaced by `discord-manager state [-g guild] [--json]`; `apply`/`watch --keep N` prunes same-guild backups to the latest N and rotates audit logs file-level at ~5 MiB (default keeps everything; live audit logs stay append-only).
- `discord.js` is an `optionalDependency` — lazy-loaded only by `watch --gateway`, which fails fast with an install hint when it is missing.
- Mutation audit logs are append-only JSONL at `~/.discord-manager/audit/<guildId>.jsonl` for apply runs from CLI, WebUI, and watch.
- Local WebUI is a Hono API plus React visual builder; Playwright self-tests need no Discord token; Plan/Apply need `DISCORD_TOKEN` and `DISCORD_GUILD_ID`.
- `ui.ts` / `npm run ui` defaults to `examples/server-config.yaml`; build `web/dist` before starting the UI.
- Live E2E is env-gated on `DISCORD_TOKEN` + `DISCORD_GUILD_ID`; design source is `Discord Server Automation — Architecture & API Analysis.html`.
- CLI `export` pulls live guild state into ServerConfig; missing welcome-screen (404) and inaccessible vanity-url (403) are soft-warned/omitted, not hard export failures.
- WebUI actionable feedback uses `AlertModal` (confirm → pending → success/error); the status bar stays idle-path only; audit JSONL still records applies; the `npm run ui` terminal stays quiet after startup.
- WebUI layout modes are phone / tablet / desktop (`useLayoutMode`), with bottom tabs on phone and drawer toggles on tablet.

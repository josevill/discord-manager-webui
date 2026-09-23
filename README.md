# discord-manager

Declarative Discord server management — infrastructure-as-code for guilds.

Point a YAML (or JSON) config at a guild, then `plan` / `apply` to converge live Discord state to that config. Idempotent, rate-limit aware, with dry-run, backups, and mutation audit logs. Includes a local visual WebUI for editing how the server should look.

## Quick start

```bash
npm install
cp .env.example .env   # set DISCORD_TOKEN and DISCORD_GUILD_ID (needed for plan/apply)
npm run build          # compiles CLI + WebUI (web/dist)
npm link               # optional: install `discord-manager` on PATH
```

### CLI

```bash
npx tsx src/cli.ts validate examples/server-config.yaml
# or after npm link:
discord-manager validate examples/server-config.yaml
discord-manager export -o current.yaml
discord-manager plan examples/server-config.yaml
discord-manager apply examples/server-config.yaml --dry-run
discord-manager apply examples/server-config.yaml --yes
```

### Web UI

Local companion visual builder (no OAuth). Edit roles, categories, channels — plus emojis, webhooks, and auto-mod rules (the Content pane) — in a Discord-like layout; Validate/Save write the same YAML the CLI uses. Image fields (guild icon/banner/splash, role icon, emoji image, webhook avatar) have a file picker that uploads into `<config dir>/assets/` and stores the relative reference. Fetch status pulls the live guild into the working config file (CloudFormation-style refresh). Fetch / Plan / Dry-run / Apply need `DISCORD_TOKEN` + `DISCORD_GUILD_ID`. Apply (and dry-run) stream per-action progress over SSE with a live progress bar in the confirm modal, and can be cancelled mid-run — cancelling stops any further Discord API calls. The Apply confirm modal also has a **prune** checkbox to delete guild resources that no longer exist in the config (same semantics as `apply --prune`).

Responsive layout: phones use a single pane with bottom Roles / Channels / Content / Edit tabs; tablets keep channels front-and-center with Roles, Content, and Edit as slide-over drawers; desktop keeps the four-pane builder; ultra-wide keeps sidebars edge-anchored and caps the center channel list width.

```bash
npm run ui      # → http://127.0.0.1:3847
```

`npm run ui` builds `web/dist` automatically when it's missing (first run) and, if the port is taken, tries the next port(s) with a notice. Run `npm run build:web` manually after changing `web/` if you want the fresh build up front.

Equivalent entry points:

```bash
npx tsx ui.ts                                 # defaults to examples/server-config.yaml
npx tsx ui.ts path/to/config.yaml --port 4000
discord-manager ui path/to/config.yaml        # after npm link / npm run build
```

Options for `ui.ts` / `npm run ui`: `[config] [--port N] [--host HOST] [-g guild] [-t token]`.

## Commands

| Command | Purpose |
|---------|---------|
| `validate <config>` | Schema + cross-reference checks |
| `export` | Live guild → YAML + `<output dir>/assets/` images (emoji/sticker/guild icons), re-applicable as-is |
| `plan` / `diff` | Show ActionPlan (no mutations) |
| `apply` | Execute plan (`--dry-run`, `--yes`, `--prune`, `--keep N`, `--no-backup`, `--no-audit`) |
| `watch` | File watcher (+ optional `--interval`, `--gateway`, `--keep N`) |
| `state` | Show the cached guild state (last fetched by export/apply/UI) |
| `ui [config]` | Local visual config builder (`ui.ts` / `npm run ui`) |
| `invite-url` | Print OAuth2 bot invite URL |

Full CLI reference: [docs/cli.md](docs/cli.md)

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | TypeScript CLI + Vite WebUI |
| `npm run build:web` | WebUI only → `web/dist` |
| `npm run ui` | Start WebUI (`tsx ui.ts`) |
| `npm run typecheck` | `tsc --noEmit` over src + ui.ts + scripts + tests + web (two projects) |
| `npm run lint` | Biome lint + format check (`biome check .`) |
| `npm run lint:fix` | Biome auto-fixes |
| `npm run format` | Biome formatter (`biome format --write .`) |
| `npm test` | Unit + integration |
| `npm run test:web` | Playwright WebUI self-tests (no Discord token) |
| `npm run test:e2e` | Live Discord E2E |
| `npm run e2e:cleanup` | Delete leftover `e2e-*` resources |

## Documentation

- [Architecture](docs/architecture.md) — fetch → diff → apply, identity keys, edge cases
- [Config reference](docs/config-reference.md) — YAML fields ↔ Discord API
- [Discord setup](docs/discord-setup.md) — bot application, intents, invite
- [Testing](docs/testing.md) — unit, coverage, live E2E, Playwright WebUI
- [Implementation notes](docs/implementation-notes.md) — module map and design choices
- Design source: [Architecture & API Analysis](./Discord%20Server%20Automation%20—%20Architecture%20%26%20API%20Analysis.html)

## Known limitations

Short version — full details in [docs/architecture.md](docs/architecture.md#known-limitations-v1):

- **Gateway drift watch is advisory only** — `watch --gateway` logs out-of-band changes but never reconciles them; convergence happens on the next file/interval reconcile.
- **Overwrites merge, not replace** — live overwrites on roles absent from config are left alone; removing a config-defined role's overwrite from the config emits an explicit zeroed overwrite so Discord actually deletes it.
- **Name-based identity** — channels match by name within their parent category (cross-category duplicate names are a validation error); no `Category/name` disambiguation in v1.
- **Sticker images are immutable on Discord** — image drift is an advisory SKIP; delete + re-create to change.
- **WebUI is unauthenticated** — it binds to 127.0.0.1 by design (local companion, no OAuth).
- **`--gateway` needs the optional `discord.js` dependency** — installed by default; after `npm install --omit=optional` run `npm install discord.js`.

## Tests

```bash
npm test                 # unit + integration only — never touches live Discord
npm run test:coverage    # coverage gate: config + reconcile engine (diff/execute) + permissions
npm run typecheck        # tsc --noEmit over src, ui.ts, scripts, tests, and web
npm run lint             # Biome lint + format check
npm run test:e2e         # live Discord (requires .env + matching E2E_ALLOW_GUILD_ID)
npm run test:web         # Playwright UI self-tests (no Discord token)
npm run e2e:cleanup      # delete leftover e2e-* resources
```

CI (`.github/workflows/ci.yml`): on push/PR it runs typecheck, lint, build,
unit + integration with the coverage gate, and the Playwright WebUI
self-tests. Live E2E is a separate job (manual dispatch or nightly cron)
that requires the `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and
`E2E_ALLOW_GUILD_ID` secrets (the allowlist must exactly match the guild).

## Requirements

- Node.js 20+
- Bot token with Manage Guild / Roles / Channels (or Administrator) for live plan/apply/E2E
- For E2E: a **disposable** test guild
- WebUI: `npm run ui` auto-builds `web/dist` on first run (or after deleting it); `npm run build:web` rebuilds manually after `web/` changes

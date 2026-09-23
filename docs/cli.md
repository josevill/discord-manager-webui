# CLI reference

```bash
discord-manager <command> [options]
# or
npx tsx src/cli.ts <command> [options]
```

Environment (also loaded from `.env`):

| Variable | Used by |
|----------|---------|
| `DISCORD_TOKEN` | All live commands |
| `DISCORD_GUILD_ID` | Default guild |
| `DISCORD_CLIENT_ID` | `invite-url` |

## validate

```bash
discord-manager validate <config>
```

Exit `0` if schema + cross-refs OK; `1` on errors. Warnings print but do not fail.

## export

```bash
discord-manager export [-g guild] [-t token] [-o file]
```

Writes YAML to stdout or file. Caches state to `~/.discord-manager/state/<guildId>.json`.

## plan / diff

```bash
discord-manager plan <config> [--prune] [--json] [-g guild] [-t token]
```

Prints ActionPlan table (or JSON). No mutations. `--prune` includes DELETE for resources missing from config.

## apply

```bash
discord-manager apply <config> [options]
```

| Flag | Meaning |
|------|---------|
| `--dry-run` | Plan only |
| `--yes` / `-y` | Skip DELETE confirmation |
| `--prune` | Delete extras not in config |
| `--keep <n>` | Retention: keep only the latest N backups; rotate the audit log (~5 MiB) keeping the latest N rotated files |
| `--no-backup` | Skip JSONL backup |
| `--no-audit` | Skip mutation audit log |
| `--json` | Emit plan as JSON |

Exit `1` if any action fails or confirmation is aborted.

## watch

```bash
discord-manager watch <config> [--auto] [--yes] [--prune] [--interval 60] [--gateway] [--keep N]
```

- Debounced file reload (500ms)  
- Without `--auto`/`--yes`: prints the plan and prompts to confirm before applying **any** change (needs a TTY; without one, reconcile is skipped with a notice)  
- `--auto` / `--yes`: apply unattended, no prompts  
- `--interval`: periodic full reconcile  
- `--keep <n>`: same retention as `apply --keep`  
- `--gateway`: log drift advisories (no auto-correct). Requires the optional
  `discord.js` dependency (installed by default; if you installed with
  `--omit=optional`, run `npm install discord.js` first)

## state

```bash
discord-manager state [-g guild] [--json]
```

Surfaces the state cache (`~/.discord-manager/state/<guildId>.json`), which
`export`, `apply`, and the WebUI Fetch write on every live guild read.

- No flags: lists every cached guild with its last fetched-at time and size
- `--guild <id>`: per-guild detail — fetch time, file, and resource counts
  (roles, categories, channels, emojis, stickers, webhooks, auto-mod rules)
  plus the warnings recorded at fetch time
- `--json`: machine-readable output for both views

Exit `1` when `--guild` names a guild with no cached state.

## invite-url

```bash
discord-manager invite-url -c <clientId> [--administrator]
```

Default permissions = recommended non-Administrator bitfield.

## ui

```bash
npm run ui
npx tsx ui.ts [config] [--port 3847] [--host 127.0.0.1] [-g guild] [-t token]
# or via the CLI:
discord-manager ui <config> [--port 3847] [--host 127.0.0.1] [-g guild] [-t token]
```

Defaults to `examples/server-config.yaml` when run via `ui.ts` / `npm run ui` with no config argument.

Starts a local visual config builder at `http://host:port`.

- Loads/saves the given YAML/JSON config on disk
- Validate / Save work without Discord credentials
- Plan / Apply require `DISCORD_TOKEN` + `DISCORD_GUILD_ID` (flags or `.env`)
- Serves the built SPA from `web/dist`, auto-building it when missing (first run)
- If the requested port is busy, tries the next port(s) (up to 10) with a notice
- Content pane edits emojis, webhooks, and auto-mod rules; image fields upload into `<config dir>/assets/`; the Apply confirm modal exposes the `--prune` equivalent

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Validation / apply / confirmation failure |

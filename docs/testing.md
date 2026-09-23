# Testing

## Local (unit + integration)

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck   # tsc --noEmit: src + ui.ts + scripts + tests + web
npm run lint        # Biome lint + format check (biome check .)
```

`npm test` runs **unit + integration only** — it never touches the live Discord
API, even when `.env` is credentialed. Live behavior requires `npm run test:e2e`
explicitly (see below).

Coverage gate (see `vitest.config.ts`) targets:

- `src/config/**`
- `src/reconcile/{diff,execute,identity,plan,resolved}.ts` — the diff/execute
  engines sit under the gate alongside the rest of the core
- `src/discord/permissions.ts`

`npm run typecheck` type-checks everything that runs: `src/**`, `ui.ts`,
`scripts/*`, `tests/*`, the Vitest/Playwright configs, and the web app (its own
`web/tsconfig.json`). The root tsconfig enables `noUncheckedIndexedAccess` so
index access stays honest. Lint/format is Biome (`biome.json`): `npm run lint`
checks, `npm run lint:fix` / `npm run format` write.

## Web UI (Playwright)

Self-tests boot the local UI against a temp copy of `examples/server-config.yaml`. No Discord token required.

```bash
npm run test:web
```

Specs live in `tests/web/` and cover load, edit/save, add role/channel, the Content pane (add + edit emojis, webhooks, and auto-mod rules, incl. actions/exemptions and persistence across reload), asset upload into `assets/` (file picker → mocked `/api/assets`), validation errors, role reorder, Plan gating when credentials are missing, and the Apply confirm modal — including danger-styled confirm, the prune checkbox (request body `prune` flag), the SSE progress stream, per-action error phase, and mid-run cancel (a local helper SSE server streams one action and holds the connection open; `route.fulfill` cannot stream bodies). The phone-mode spec also covers the bottom-tab Content pane.

## Live E2E

**Requirements**

- Disposable guild (assume destructive ops)  
- Bot invited with manage permissions, role high enough  
- `.env`:

```
DISCORD_TOKEN=...
DISCORD_GUILD_ID=...
E2E_ALLOW_GUILD_ID=...   # required safety allowlist (must equal DISCORD_GUILD_ID)
```

```bash
npm run test:e2e
```

**Fail-fast allowlist:** if `E2E_ALLOW_GUILD_ID` is unset or does not exactly
match `DISCORD_GUILD_ID`, the suite throws in `beforeAll` instead of running.
There is no default-allow — a plain `npm test` also never picks up `tests/e2e`.

Harness (`tests/e2e/live.test.ts`):

- Skips only when credentials are missing  
- Throws when the allowlist is missing/mismatched  
- Prefixes resources `e2e-<runId>-`  
- Tears down matching resources in `afterAll`  
- Scenarios: validate, export, create/update/idempotent roles+channels (strict no-op re-plan), dry-run/backup, large permission bitfields  

Cleanup leftovers:

```bash
npm run e2e:cleanup
npm run e2e:cleanup -- e2e-abc123-
```

## CI

`.github/workflows/ci.yml` runs on push/PR: typecheck → lint (Biome) → build →
unit + integration with the coverage gate → Playwright WebUI self-tests.
Live E2E is a separate `e2e` job triggered only by manual dispatch or the
nightly schedule; it requires the `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and
`E2E_ALLOW_GUILD_ID` secrets and fails fast unless the allowlist exactly
matches the guild (no default-allow, same rule as locally).

## Safety rules

1. Never point E2E at a production guild  
2. Prefer empty disposable servers  
3. Always use `--yes` only in automation against disposable guilds  
4. Keep `E2E_ALLOW_GUILD_ID` set in CI secrets  

## Rate limits

The REST client uses progressive delay (100ms base, +50ms on 429). E2E may take minutes on large plans — timeouts are elevated to 60–120s.

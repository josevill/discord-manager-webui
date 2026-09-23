# Config reference

Config files are YAML or JSON. Loaded with Zod (`src/config/schema.ts`), then cross-checked (`src/config/validate.ts`).

## Top-level keys

| Key | Description |
|-----|-------------|
| `guild` | Guild metadata (name, description, verification, icons, …) |
| `roles` | Role list (include `@everyone` to set default perms) |
| `categories` | Category channels (type 4) |
| `channels` | Text/voice/announcement/forum/media/stage |
| `emojis` | Custom emoji uploads (`image` path) |
| `stickers` | Guild stickers (`image` path; text fields mutable, image not) |
| `webhooks` | Per-channel webhooks |
| `auto_mod.rules` | Auto Moderation rules |
| `welcome_screen` | Community welcome screen |
| `onboarding` | Community onboarding |
| `vanity_url_code` | Requires boost tier 3 |
| `widget` | Server widget |
| `invite_splash` | Alias for guild splash asset |

## Permissions

Accept either:

```yaml
permissions: "1024"                    # decimal string (preferred for large bitfields)
permissions: [VIEW_CHANNEL, SEND_MESSAGES]  # named flags
```

Named flags map to Discord permission bits via `src/discord/permissions.ts`.

Channel overwrites:

```yaml
permission_overwrites:
  - role: "@everyone"
    allow: [VIEW_CHANNEL]
    deny: [SEND_MESSAGES]
```

## Roles

| Field | Notes |
|-------|-------|
| `name` | Identity key (managed roles and `@everyone` are special-cased) |
| `color`, `hoist`, `mentionable`, `permissions`, `position` | Standard fields; `position` applied via batch reorder |
| `unicode_emoji` | Unicode character used as the role icon (e.g. `"🦊"`). Compared against live; set `null` to clear. Not settable on `@everyone`. |
| `icon` | Local asset path for the role icon. Uploaded when the sha1 of the local file differs from the live icon hash. `null`/omitted = not managed (existing icon left alone). |

## Stickers

| Field | Notes |
|-------|-------|
| `name` | Identity key. 2–30 chars; matched against the guild's sticker list |
| `description` | Mutable — PATCHed when it differs |
| `tags` | Mutable — PATCHed when it differs |
| `image` | Local asset path (PNG/APNG/GIF/Lottie JSON) or `http(s)` URL. Only used on CREATE — **Discord cannot update a sticker's image**. If the local file's sha1 differs from the live sticker's CDN hash, plan shows an advisory warning instead of an action; change the image by deleting the sticker (remove it from config and `--prune`, or delete in Discord) and re-creating it |

Sticker CREATE is a `multipart/form-data` upload (Discord rejects JSON bodies). `apply --prune` deletes guild stickers whose name is absent from config.

## Channel types

| Config | Discord type |
|--------|--------------|
| `text` | 0 |
| `voice` | 2 |
| `category` | 4 |
| `announcement` | 5 |
| `stage` | 13 |
| `forum` | 15 |
| `media` | 16 |

## Constraints (validated)

- Channel names: alphanumeric, `-`, `_`, and **unique across the whole config** (a name in two categories is an error — channel identity is name-only, so `webhooks`/`auto_mod`/`welcome` refs would be ambiguous)  
- Role names: 1–100 chars  
- Emoji names: 2–32 alphanumeric + `_`  
- Sticker names: 2–30 chars  
- Cross-refs: categories, roles, channels must exist when referenced  
- Topic ≤ 1024; slowmode 0–21600; bitrate 8000–384000  

## Assets

Local paths are relative to the config file directory and uploaded as base64 data URIs on apply (`icon`, `banner`, `splash`, role `icon`, emoji/sticker/webhook images; sticker CREATE is a multipart upload).

`http(s)://` URLs are accepted for any image field: the executor downloads them at apply time (the bot token is only sent to Discord-owned CDN hosts). At plan time the URL is downloaded and hashed so URL-valued assets are diffed like local files — no perpetual re-upload.

Asset change detection (sha1 of the asset bytes vs. the live asset hash, so unchanged assets are never re-uploaded):

- Guild `icon` / `banner` / `splash` — compared to the live guild asset hash.
- Role `icon` — compared to the live role icon hash.
- `webhooks[].avatar` — compared to the live webhook avatar hash.
- `emojis[].image` — the Discord API exposes no hash for emoji images, so every fetch downloads each emoji from the CDN and hashes the bytes (concurrency-bounded). If a download fails, a warning is emitted and that emoji's image is assumed unchanged.
- `stickers[].image` — same convention via the media CDN (`media.discordapp.net/stickers/<id>.<ext>`, no auth). A mismatch is advisory only (image is immutable; see Stickers).

When a hash cannot be computed on either side (download failed, missing local file), the asset is **assumed unchanged** — re-uploading could never converge, so assuming equality is what keeps apply idempotent.

`export` (CLI and the WebUI *Fetch status*) downloads emoji/sticker/guild-icon images into `<config dir>/assets/` and rewrites the config to relative `assets/…` paths, so an exported baseline re-applies without manual edits. Download failures fall back to CDN URLs (emoji) / media-CDN URLs (stickers) or leave the field unmanaged (guild assets), with a warning — the export never hard-fails on an asset.

See [examples/server-config.yaml](../examples/server-config.yaml).

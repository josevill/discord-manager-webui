# Discord bot setup

## 1. Create the application

1. Open [Discord Developer Portal](https://discord.com/developers/applications)  
2. **New Application** → name it  
3. **Bot** → Add Bot → copy token → set `DISCORD_TOKEN`  
4. Enable Privileged Gateway Intents as needed:
   - **Server Members Intent** — if you later assign member roles  
   - **Message Content Intent** — only if you read message content  
5. For watch `--gateway`, non-privileged intents used: Guilds, GuildModeration, GuildEmojisAndStickers, GuildWebhooks  

## 2. Invite the bot

```bash
discord-manager invite-url -c YOUR_CLIENT_ID
# or with Administrator:
discord-manager invite-url -c YOUR_CLIENT_ID --administrator
```

Recommended permissions (non-Admin): Manage Guild, Manage Roles, Manage Channels, Manage Webhooks, Manage Expressions, View Audit Log, Moderate Members, Manage Messages, View/Send/History, etc.

**Critical:** Drag the bot’s role **above** any roles it must manage.

## 3. Disposable test guild

1. Create a throwaway server  
2. Enable Developer Mode → Copy Server ID → `DISCORD_GUILD_ID`  
3. Optionally set `E2E_ALLOW_GUILD_ID` to the same ID so E2E refuses other guilds  

## 4. Data directory

```
~/.discord-manager/
  state/<guildId>.json
  backups/<guildId>_<timestamp>.jsonl
  audit/<guildId>.jsonl
```

Append-only audit lines record each apply run (`cli` / `ui` / `watch`) and every CREATE/UPDATE/DELETE attempt (success or failure). Use `--no-audit` to skip.

## 5. Multi-guild

Pass `-g <guildId>` per command, or keep separate config files and env per guild. A future layout can mirror `~/.discord-manager/configs/guild_<id>.yaml`.

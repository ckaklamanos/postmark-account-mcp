# postmark-account-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for Postmark that works across
**all servers of one or more Postmark accounts**.

- Auth with **Account API tokens**; each server's token is discovered automatically (`GET /servers`).
- New servers / accounts appear without reconfiguration (5-min cache, accounts file re-read on refresh).
- **No send / create / update / delete operations exist** — on purpose.

## Tools

Every tool takes optional `account` and `server` (partial, case-insensitive; `server` also accepts a
numeric ID or `account/server`). Omit them to query everything.

| Tool | What |
|---|---|
| `list_servers` | All accounts → servers → message streams (tokens never returned) |
| `search_messages` | Outbound search (recipient, sender, subject, tag, status, stream, dates) |
| `get_message_details` | Event timeline of one message (Delivered / Bounced / Opened / Clicked); finds its server automatically |
| `search_bounces` | Bounces (email, type, inactive, dates) |
| `list_suppressions` | Suppressed recipients per stream |
| `delivery_stats` | Sent / bounce rate / spam / opens / clicks |

## Install (on any machine)

```bash
git clone https://github.com/ckaklamanos/postmark-account-mcp.git ~/Applications/postmark-account-mcp
cd ~/Applications/postmark-account-mcp && npm install

# accounts file — kept OUTSIDE the repo
mkdir -p ~/.config/postmark-account-mcp
cp accounts.example.json ~/.config/postmark-account-mcp/accounts.json
chmod 600 ~/.config/postmark-account-mcp/accounts.json
# edit it: { "account-name": "account-api-token", ... }

# register in Claude Code for ALL projects
claude mcp add --scope user postmark -- node ~/Applications/postmark-account-mcp/index.js
```

Account API token: Postmark → **Account** → **API Tokens** (not a server token).

## Configuration

| Variable | Default |
|---|---|
| `POSTMARK_ACCOUNTS_FILE` | `~/.config/postmark-account-mcp/accounts.json` |
| `POSTMARK_ACCOUNT_TOKEN` | Fallback single account (`default`) if no accounts file exists |

Accounts file format: `{ "name": "token", ... }` (or `{ "accounts": { ... } }`).

## Update

```bash
cd ~/Applications/postmark-account-mcp && git pull && npm install
```
Then restart Claude Code.

Requires Node 18+.

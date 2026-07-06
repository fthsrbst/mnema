# İstemci Bağlantıları

`<HUB>` = `http://<pi-tailscale-ip>:8033` (lokal dev: `http://127.0.0.1:8033`)
`<TOKEN>` = Pi'deki `.env` içindeki `HUB_TOKEN`

## Claude Code
```bash
claude mcp add --transport http --scope user hub <HUB>/mcp \
  --header "Authorization: Bearer <TOKEN>"
```
Auto-recall hook'u: `claude-code-settings.example.json` → `~/.claude/settings.json`.
Ayrıca her cihazda bir kez: `hub config set url <HUB>` ve `hub config set token <TOKEN>`.

## Cursor / Windsurf (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "hub": {
      "url": "<HUB>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

## opencode (`~/.config/opencode/opencode.json`)
```json
{
  "mcp": {
    "hub": {
      "type": "remote",
      "url": "<HUB>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

## Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.hub]
url = "<HUB>/mcp"
http_headers = { "Authorization" = "Bearer <TOKEN>" }
```

## Özel agentlar
REST: `GET <HUB>/api/memory/search?q=...` (header: `Authorization: Bearer <TOKEN>`).
Uçlar için `src/server/rest.ts`.

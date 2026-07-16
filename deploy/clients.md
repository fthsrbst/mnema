# İstemci Bağlantıları

`<HUB>` = `http://<pi-tailscale-ip>:8033` (lokal dev: `http://127.0.0.1:8033`)
`<TOKEN>` = Pi'deki `.env` içindeki `HUB_TOKEN`

## Telefondan erişim (mobil)

Pi'de `tailscale serve` aktif: hub, tailnet içinde HTTPS ile yayında —
**https://fatihpi.tail2daf77.ts.net** (dışarıya kapalı, sadece kendi cihazların).

1. **Tailscale uygulamasını kur** (iOS/Android), aynı hesapla (fatihxserbest@gmail.com) gir, VPN'i aç.
   MagicDNS mobilde varsayılan açık — adres doğrudan çözülür.
2. **Web paneli**: tarayıcıda `https://fatihpi.tail2daf77.ts.net` → token'ı gir (Pi `.env` → `HUB_TOKEN`).
   "Ana ekrana ekle" ile PWA olarak kur — uygulama gibi açılır.
3. **AI uygulamalarından erişim (MCP)**:
   - MCP destekleyen mobil/uzak istemcilere endpoint: `https://fatihpi.tail2daf77.ts.net/mcp`,
     header: `Authorization: Bearer <TOKEN>`.
   - **claude.ai / Claude mobil uygulaması custom connector**: Anthropic sunucuları tailnet'e giremez;
     bunun için endpoint'i internete açmak gerekir: `sudo tailscale funnel --bg 8033`.
     ⚠️ Funnel hub'ı HERKESE açar — tek koruma bearer token kalır. Açmadan önce düşün;
     kapatmak için `sudo tailscale funnel --https=443 off`.
   - Tailnet içindeki her istemci (ör. dizüstünde Claude Code) zaten `http://100.110.9.26:8033/mcp` ile bağlanır.

Serve'i kapatmak: Pi'de `sudo tailscale serve --https=443 off`.

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

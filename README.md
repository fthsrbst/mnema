# AI Hub

Tüm AI agentların (Claude Code, opencode, Cursor, Codex, özel agentlar) ortak hafızası.
Raspberry Pi üzerinde çalışır; hafıza + RAG + proje maplerini MCP ve REST ile sunar.

## Hızlı başlangıç (lokal dev)

```bash
npm install
cp .env.example .env      # GEMINI_API_KEY ekle (boşsa FTS-only çalışır)
npm run dev               # http://127.0.0.1:8033
npm run smoke             # uçtan uca test
```

## Agent bağlama

```bash
# Claude Code
claude mcp add --transport http hub http://<pi-tailscale-ip>:8033/mcp \
  --header "Authorization: Bearer <HUB_TOKEN>"
```

Cursor (`~/.cursor/mcp.json`) ve opencode için `deploy/clients.md`ye bak.

## Auto-recall (her mesajda otomatik hafıza)

Claude Code `UserPromptSubmit` hook'u her mesajında hub'da arama yapıp ilgili
kayıtları bağlama enjekte eder. Kurulum: `deploy/claude-code-settings.example.json`.

## CLI

```
hub search "auth kararı"     hub remember "..." --type decision
hub projects                 hub project <ad>
hub index ./docs             hub log "oturum özeti" -p <proje>
hub sync                     hub status
```

## Pi'ye kurulum

`deploy/setup-pi.sh` — ayrıntı için `deploy/README.md`.

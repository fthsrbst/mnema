# Yerel Modeller ve Hub — LM Studio & Ollama

İki yönlü entegrasyon var:

1. **Hub → yerel model:** `local_llm` aracı LM Studio **veya** Ollama'daki modelle üretim yapar (ikisi de OpenAI-uyumlu `/v1` API sunar).
2. **Yerel model → hub:** LM Studio'daki modeller MCP üzerinden hub araçlarına (hafıza, RAG, proje mapleri) erişir.

## 1. Hub'ın yerel modeli kullanması (`local_llm`)

Makineyi portlarıyla kaydet (MCP `machine_register`, REST `PUT /api/machines/:name` veya web UI → Makineler):

```jsonc
{ "name": "fatih-pc", "host": "100.x.x.x", "lmstudio_port": 1234, "ollama_port": 11434, "comfyui_port": 8000 }
```

- `machine_status` / `hub machines` → hangi servis açık, hangi modeller yüklü.
- `local_llm(prompt, backend?, model?, machine?)` — `backend` boşsa **LM Studio öncelikli**, `backend: "ollama"` ile Ollama seçilir.
- CLI: `hub llm "özetle: ..." --backend ollama -m llama3.2`

Notlar:
- Ollama'nın OpenAI-uyumlu API'si `http://host:11434/v1` altındadır; hub bunu otomatik kullanır. Model listesi `/v1/models`'ten gelir (yüklü/pull edilmiş modeller).
- Ollama'ya dışarıdan (Tailscale IP ile) erişim için Ollama'nın `OLLAMA_HOST=0.0.0.0` ile çalışması gerekir — varsayılan sadece 127.0.0.1'i dinler.
- LM Studio'da da "Serve on Local Network" açık olmalı (Developer sekmesi).

## 2. Yerel modellerin hub'a erişmesi (MCP)

### LM Studio

LM Studio 0.3.17+ MCP destekler (`~/.lmstudio/mcp.json`, Cursor formatı). Otomatik kurulum:

```
hub agents connect
```

Bu, `~/.lmstudio/mcp.json`'a şunu yazar (URL/token CLI config'inden gelir):

```json
{
  "mcpServers": {
    "hub": {
      "url": "http://<hub-host>:8033/mcp",
      "headers": { "Authorization": "Bearer <HUB_TOKEN>" }
    }
  }
}
```

Sonra LM Studio chat'inde tool use açık bir modelle (ör. Qwen, Llama 3.x instruct) `memory_search`, `recall`, `project_get` vb. araçlar kullanılabilir. Küçük modeller için ipucu: sistem promptuna "önce memory_search ile ara" gibi net talimat ver — `prompt_get('master')` içeriği de uygundur.

### Ollama

Ollama'nın kendi arayüzünün MCP istemcisi yok. Seçenekler:

- **Hub üzerinden (önerilen):** Ollama modelini `local_llm(backend:"ollama")` ile hub çağırır; hafıza bağlamını agent recall ile ekler. Yerel modelin hub'a doğrudan erişmesi gerekmez.
- **MCP istemcisi olan bir UI:** Open WebUI (mcpo köprüsü), LibreChat, Cherry Studio gibi arayüzler Ollama modelini çalıştırıp hub MCP'ye bağlanabilir. Hub adresi: `http://<pi-veya-pc>:8033/mcp`, header `Authorization: Bearer <token>` (veya `?token=` query).
- **Düz REST:** Herhangi bir araç `GET /api/memories?q=...`, `POST /api/rag/search` gibi REST uçlarını token'la çağırabilir — function-calling yapan her yerel model için en basit köprü budur.

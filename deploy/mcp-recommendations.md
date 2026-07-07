# MCP Sunucu Önerileri

Mimari not: **hub zaten senin ana MCP sunucun** — hafıza, RAG, proje mapleri ve
yerel AI orkestrasyonu tek uçtan geliyor. Diğer MCP'ler her istemciye ayrı ayrı
eklenir; buradaki liste denenmiş/faydalı olanlar. Az sayıda ama iyi MCP > çok
sayıda tool (her tool bağlam maliyeti; kullanmadığını kurma).

## Kurulu
| MCP | Ne işe yarar | Not |
|---|---|---|
| **hub** | Ortak hafıza + RAG + proje mapleri + local_llm + image_generate | Bu repo |
| **context7** | Güncel kütüphane dokümantasyonu (React, Next, her şey) | `claude mcp add --transport http --scope user context7 https://mcp.context7.com/mcp` |

## Duruma göre öner (ihtiyaç doğunca kur)
| MCP | Ne zaman |
|---|---|
| **playwright** (`npx @playwright/mcp@latest`) | Web app'i tarayıcıda test ettirmek, E2E debug |
| **github** (resmi, OAuth) | PR/issue yönetimini agent'a devretmek — `gh` CLI çoğu işi zaten görüyor, yoğun PR akışın olursa kur |
| **postgres/sqlite MCP** | Bir projede DB'yi agent'a sorgulatmak gerekirse |

## Kurmaya değmeyecekler
- **filesystem/git/fetch MCP'leri** — Claude Code, Cursor ve opencode'da bunlar built-in; MCP versiyonları sadece bağlam şişirir.
- **"memory" MCP'leri** (mem0, openmemory vb.) — hub bunun yerine var; ikinci hafıza sistemi tutarsızlık üretir.

## Diğer istemcilere ekleme
Aynı MCP'leri Cursor/opencode/Codex'e eklemek için `deploy/clients.md`'deki
format geçerli; sadece URL/komut değişir.

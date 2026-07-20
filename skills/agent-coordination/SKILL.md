---
name: agent-coordination
description: Agent koordinasyonu — yetenek kaydı, mesajlaşma, inbox kontrolü, structured handoff. Birden fazla agent'ın aynı projede çalıştığı veya iş devri gerektiğinde kullan.
---

# Agent Koordinasyonu

Hub, agent'ların birbirini bulması, iletişim kurması ve iş devretmesi için altyapı sağlar.

## Yetenek Kaydı (Capability Registry)

Her agent kendi yeteneklerini kaydeder:

### agent_register
```json
{
  "agent": "claude-code",
  "machine": "fatih-pc",
  "capabilities": ["code_review", "testing", "refactoring", "documentation"],
  "models": ["claude-sonnet-4-20250514"],
  "max_concurrent": 2
}
```

### agent_find
İş için uygun agent bulmak:
```json
{ "capability": "testing", "project": "my-project" }
```
- Yeteneğe göre eşleşen, `available` durumundaki agent'ları döner

### agent_heartbeat
Uzun süren işlerde canlılık sinyali:
```json
{ "uid": "agent-uid" }
```
- 60 dakika heartbeat gelmezse agent `offline` işaretlenir

## Mesajlaşma

### agent_message_send
```json
{
  "from_agent": "claude-code",
  "to_agent": "cursor-agent",
  "project": "my-project",
  "kind": "request",
  "subject": "API test'i gerekli",
  "body": "Yeni endpoint'ler eklendi, smoke test rica ediyorum"
}
```

Mesaj türleri (`kind`):
- `info` — bilgilendirme
- `request` — istek/rica
- `response` — yanıt
- `handoff` — iş devri (payload ile bağlam taşır)
- `alert` — acil uyarı

### agent_inbox
Okunmamış mesajları almak:
```json
{ "agent": "cursor-agent", "limit": 10 }
```

### agent_message_read
Mesajı okundu işaretle:
```json
{ "uid": "message-uid" }
```

## Structured Handoff (İş Devri)

Bir agent'tan diğerine tam bağlam devri:

### agent_handoff
```json
{
  "from_agent": "claude-code",
  "to_agent": "cursor-agent",
  "project": "my-project",
  "notes": "Auth modülünde kaldım, token refresh mantığı eksik"
}
```

Handoff paketi şunları içerir:
- Proje map'i (mimari, modüller, komutlar)
- Son 3 oturum özeti
- Aktif görevler
- Agent presence (kim çalışıyor)
- İlgili hafızalar

**Ne zaman handoff:**
- Oturum kapanıyor ama iş bitmedi
- Başka agent'ın uzmanlığı gerekli
- Uzun süreli iş devri

## Inbox Kontrol Zamanları

| Durum | Aksiyon |
|---|---|
| Oturum başı | `agent_inbox` kontrol et |
| Görev claim öncesi | İlgili mesaj var mı bak |
| Uzun iş ortası | Periyodik inbox kontrolü |
| Handoff sonrası | Mutlaka inbox'ı oku |

## En İyi Pratikler

1. **Kayıt ol:** Çalışmaya başlarken `agent_register` ile yeteneklerini bildir
2. **Heartbeat:** Uzun işlerde periyodik `agent_heartbeat` gönder
3. **Inbox:** Oturum başında ve handoff sonrası inbox'ı kontrol et
4. **Handoff:** İş devrederken `notes` alanına bağlam yaz — sonraki agent sıfırdan başlamasın
5. **Mesaj tipi:** Doğru `kind` kullan — `alert` sadece gerçekten acil durumlar için
6. **Broadcast:** `to_agent` boş bırakılırsa tüm agent'lara gider — dikkatli kullan

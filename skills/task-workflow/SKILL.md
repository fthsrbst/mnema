---
name: task-workflow
description: Görev kuyruğu iş akışı — görev oluşturma, claim etme, tamamlama, bağımlılık yönetimi. Birden fazla agent'ın koordineli çalışması gereken durumlarda kullan.
---

# Görev İş Akışı (Task Workflow)

Hub görev kuyruğu, agent'lar arası iş delegasyonunu sağlar. Bir agent iş oluşturur, başka bir agent (veya aynı agent farklı oturumda) o işi üstlenir ve tamamlar.

## Görev Yaşam Döngüsü

```
pending → claimed → in_progress → done
                  ↘ blocked ↗
                  ↘ cancelled
```

## Ne Zaman Görev Oluşturmalı

| Durum | Aksiyon |
|---|---|
| Büyük iş parçalara bölünebilir | Her parça için ayrı görev |
| Başka agent'ın uzmanlığı gerekli | `agent_find` ile uygun agent bul, görev oluştur |
| Paralel çalışılabilir alt işler var | Bağımsız görevler oluştur |
| Sıralı bağımlılık var | `depends_on` ile zincirle |

## MCP Araçları

### task_create
```json
{
  "title": "API endpoint'lerini test et",
  "description": "Tüm REST endpoint'lerinin smoke test'i",
  "project": "my-project",
  "priority": 5,
  "tags": ["testing", "api"],
  "created_by": "claude-code"
}
```

### task_claim
Bir görevi üstlenmek için:
```json
{ "uid": "task-uid", "agent": "cursor-agent" }
```
- Sadece `pending` durumundaki görevler claim edilebilir
- Bağımlılıkları (`depends_on`) tamamlanmamış görevler claim edilemez

### task_update
Durum değiştirmek için:
```json
{ "uid": "task-uid", "status": "in_progress" }
```

### task_complete
İşi bitirince:
```json
{ "uid": "task-uid", "result": "15 endpoint test edildi, 2 hata bulundu" }
```
- `result` alanına yapılandırılmış çıktı koy — sonraki agent bu bilgiyi kullanır

### task_queue
Proje için sıradaki işleri almak için:
```json
{ "project": "my-project", "limit": 5 }
```
- Önceliğe göre sıralı, bağımlılıkları karşılanmış görevleri döner

## Bağımlılık Yönetimi

```json
{
  "title": "Frontend'i backend'e bağla",
  "depends_on": ["backend-api-uid", "auth-uid"]
}
```
- `depends_on` içindeki tüm görevler `done` olmadan bu görev claim edilemez
- Döngüsel bağımlılık oluşturma

## Öncelik (Priority)

- `0` = normal (varsayılan)
- `1-5` = artan aciliyet
- `10+` = kritik (sadece gerçekten acil durumlar için)

## En İyi Pratikler

1. **Küçük tut:** Her görev 30dk-2 saat arası iş olmalı
2. **Açık yaz:** `description` alanına bağlam, kabul kriterleri, ilgili dosyalar ekle
3. **Sonuç bırak:** `task_complete` çağırırken `result`'a sonraki agent'ın işine yarayacak bilgi koy
4. **Bağımlılıkları belirt:** Paralel çalışılabilecek işleri ayır, sıralı işleri zincirle
5. **Gereksiz görev oluşturma:** Tek agent'ın tek oturumda yapacağı iş için görev kuyruğuna gerek yok

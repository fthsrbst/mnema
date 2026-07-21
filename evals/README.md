# Context evaluation

`context-golden.json` is the checked-in seed regression set. It is useful for catching authority-order, stale-status, negative-query, bilingual routing, and known retrieval regressions, but it is not large enough to approve ranking changes.

Run:

```bash
npm run eval:context
```

The release gate requires at least 50 human-reviewed cases and a 100% pass rate:

```bash
npm run eval:context:release
```

Do not satisfy the gate by duplicating or mechanically paraphrasing cases. Each case must be labelled from a real information need, carry non-empty `reviewed_by` and `reviewed_at` fields after a person verifies it, and include at least one of: expected authority, expected memory/document, forbidden stale source, explicit empty evidence, or isolation warning. Keep a balanced set across current status, decisions, technical history, documentation, preferences, multilingual queries, negative queries, and project isolation.

When ranking changes, record both the before and after report. A gain in average recall does not permit a stale current-status hit or cross-project leak.

## Bütçe parametreleri hakkında (2026-07-21)

Bir vakanın `max_tokens` değeri, iddia ettiği şeyi taşıyabilecek kadar geniş olmalıdır.
`mnema-pi-deploy-history-turkish` 5 memory isteyen `technical_history` niyetini test ediyordu
ama 2000 token yalnız 3'ünü alabiliyordu; beklenen kayıt 5. sıradaydı ve bütçe onu kırpıyordu.
Ölçüm: 2000 → 3 memory (kırpıldı), 2600 → 5 memory (beklenen kayıt geldi). Değer 3000'e
çıkarıldı — retrieval sıralaması doğruydu, hatalı olan vakanın kendi parametresiydi.

Aynı denetimde iki gerçek kusur bulundu ve düzeltildi:
- `enforceBudget` authority bloğuna dokunmadan ÖNCE bütün kanıtı atıyordu; proje map'i
  büyüdükçe sorgu ne olursa olsun sıfır kanıtla dönülüyordu. Artık kanıt bir tabana kadar
  (1 chunk / 1 memory) korunuyor, gerekirse authority kırpılıyor.
- `compactProject` alanları insan-okuru uzunluğundaydı ve her pakete giriyordu
  (~799 token). Sınırlar daraltıldı.

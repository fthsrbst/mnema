---
name: media-gen
description: Hub üzerinden ComfyUI ile medya üretimi — görsel, video, görsel düzenleme (ses/3D eklenecek). Bir iş için görsel/video gerektiğinde (UI asset, blog kapağı, animasyon, test medyası) agent kendisi üretir. Workflow seçimi, placeholder kullanımı ve hata ayıklama.
---

# Medya Üretimi (ComfyUI via Hub)

Bir görsel/video gerektiğinde kullanıcıdan isteme — hub'daki `media_generate` ile kendin üret.

## Akış
1. `machine_status` → ComfyUI açık mı? Kapalıysa kullanıcıya "ComfyUI'ı açar mısın" de.
2. `workflow_list` → mevcut workflowlar. `media_generate(workflow, inputs)` çağır.
3. Dönen `files` hub'daki yerel yol, `urls` HTTP erişimi. Dosyayı işinde doğrudan kullan.

## Workflow envanteri (doğrulanmış)
| Workflow | İş | Süre | Notlar |
|---|---|---|---|
| `z-image-t2i` | Hızlı görsel taslak/iterasyon | ~15-30sn | width/height/steps/cfg ayarlanabilir |
| `flux2-t2i` | Kaliteli final görsel | ~1-2dk | `turbo=false` → 20 adım en iyi kalite |
| `qwen-image-t2i` | Görsel; **metin/tipografi içerenlerde en iyi** | ~30sn (turbo) | `turbo=false` → 50 adım |
| `qwen-image-edit` | Var olan görseli talimatla düzenleme | ~30-60sn | `image_path`: yerel dosya (otomatik yüklenir), `prompt`: düzenleme talimatı |
| `wan22-t2v` | Text-to-video | dk'lar | `length`: kare sayısı (16fps; 81≈5sn), test için 33 kullan |

## Prompt kuralları
- **İngilizce yaz** — görsel modeller İngilizce prompt'ta belirgin daha iyi.
- Zenginleştir: özne + stil + kompozisyon + ışık ("a minimal flat illustration of ..., soft colors, centered composition").
- İterasyon stratejisi: önce `z-image-t2i` ile 2-3 varyant (farklı seed), beğenilen kompozisyonu `flux2-t2i`/`qwen-image-t2i` ile finalize et.
- Aynı seed + aynı prompt = aynı sonuç; varyant için seed'i verme (otomatik rastgele).

## Hatalar
- "workflow yok" → `workflow_list`; yeni workflow ekleme: kullanıcı ComfyUI'da kurar, `scripts/comfy-convert.ts` API formatına çevirir.
- "doldurulmamış girdi bekliyor: X" → `inputs.X` ver.
- Zaman aşımı → ilk çağrıda model VRAM'e yüklenir (yavaş); `timeoutSec: 600+` ile tekrarla. Video için 900+.
- Üretim kalitesi kötüyse önce prompt'u zenginleştir, sonra turbo=false dene.

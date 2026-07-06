---
name: new-project
description: Yeni yazılım projesi başlatma — scaffold, git, proje map'i ve CLAUDE.md'yi tek akışta kurar. Kullanıcı "yeni proje", "X diye bir şey yapalım" dediğinde kullan.
---

# Yeni Proje

## Adımlar
1. **Netleştir (tek soru turu):** ne yapacak, hangi stack (belirtilmediyse code-conventions'taki varsayılanlar: TypeScript strict + npm).
2. **Scaffold:** klasör, git init, .gitignore, README (tek paragraf amaç), lint/format config, "hello world" çalışır iskelet.
3. **CLAUDE.md yaz** (proje köküne): projenin amacı, stack, çalıştırma komutları, hub'daki proje adı.
4. **Hub'a kaydet:** `project_update` ile map oluştur:
   - `name`: klasör adıyla aynı (kebab-case)
   - `status`: active, `summary`: tek paragraf
   - `stack`, `current_focus`: ilk hedef
   - `next_steps`: ilk 2-3 somut adım
5. **İlk karar logu:** stack seçimi gerekçesiyle `project_add_decision`.
6. GitHub repo isteniyorsa: `gh repo create <name> --private --source . --push`.

## Kurallar
- Boilerplate'i minimumda tut; kullanılmayacak dosya üretme.
- README'ye "nasıl çalıştırılır" mutlaka yaz (tek komut hedefle).
- Proje adı hub map'i, klasör ve repo'da **aynı** olsun — arama tutarlılığı.

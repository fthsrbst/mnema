---
name: code-conventions
description: Fatih'in kod standartları — tüm agentların aynı stilde kod yazması için tek kaynak. Herhangi bir projede kod yazarken veya yeni proje kurarken uygula.
---

# Kod Standartları

> Bu dosya tek kaynak: burada değişiklik yap, `hub sync` ile tüm cihazlara dağıt.
> (Aşağıdakiler başlangıç varsayımları — Fatih'le çalıştıkça netleşen tercihleri buraya işle
> ve önemli olanları `memory_save` type=preference ile de kaydet.)

## Genel
- Dil: yeni projelerde varsayılan **TypeScript** (strict). Script işleri için Python kabul.
- Paket yöneticisi: npm. Node LTS.
- Format/lint: prettier varsayılanları + eslint; tartışma çıkarsa prettier kazanır.
- Yorumlar: kodun kendisinin gösteremediği kısıtları yaz; "ne yaptığını" anlatan yorum yazma.
- Hata yönetimi: hataları yutma; ya anlamlı mesajla yükselt ya da bilinçli degrade et (log'la).

## İsimlendirme
- Dosyalar: kebab-case. Tipler/sınıflar: PascalCase. Fonksiyon/değişken: camelCase.
- Türkçe değişken adı kullanma; kullanıcıya görünen metinler Türkçe olabilir.

## Git
- Küçük, tek amaçlı commitler. Mesaj: emir kipi, ilk satır ≤ 72 karakter.
- main'e direkt push yok (kişisel deneme repoları hariç).

## Mimari refleksler
- Önce en basit çalışan çözüm; soyutlamayı ikinci tekrarında ekle.
- Konfig: env değişkenleri + tek config modülü; sihirli sabitleri koda gömme.
- Dış servis çağrılarında timeout + anlamlı hata mesajı zorunlu.

## Bu skill'i güncelleme
Fatih bir stil tercihi belirttiğinde: (1) bu dosyaya işle, (2) `memory_save` type=preference ile hub'a yaz, (3) kullanıcıya "conventions'a ekledim" de.

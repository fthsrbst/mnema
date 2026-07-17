-- 0002: session_logs & memory_relations doğrudan yazma yetkisini kapat (kota çiti).
--
-- 0001, bu iki tabloya authenticated rolüne tam CRUD grant vermişti. memories/documents/
-- projects'in aksine bunların kota-muhasebeli RPC'si yok ve used_storage_bytes hesabına
-- girmiyorlar; hosted Cloud'da onları yazan hiçbir route/UI da yok. Sonuç: herhangi bir üye,
-- Supabase URL + publishable key ile PostgREST'e doğrudan POST atarak (cloud-router'ı hiç
-- görmeden) sınırsız summary/text yazıp plan depolama kotasını atlatabiliyordu.
--
-- Yazma yetkisi kaldırılıyor; okuma (select) RLS altında açık kalıyor. Ürün bu tablolara
-- yazmayı sunacağı gün, add_memory/add_document gibi kota-muhasebeli SECURITY DEFINER
-- RPC'lerle geri açılmalı — doğrudan grant ile DEĞİL.

revoke insert, update, delete on public.session_logs from authenticated;
revoke insert, update, delete on public.memory_relations from authenticated;

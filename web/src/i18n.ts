// Hafif i18n çözümü — kütüphane yok, tek sözlük modülü.
// Kullanım: const { lang, setLang, t } = useI18n();

import { createContext, useCallback, useContext, useState } from "react";

export type Lang = "tr" | "en";

const STORAGE_KEY = "hub_lang";

export function getLang(): Lang {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "en" ? "en" : "tr";
}

export function setStoredLang(lang: Lang): void {
  localStorage.setItem(STORAGE_KEY, lang);
}

const dict = {
  // --- nav ---
  "nav.sectionGeneral": { tr: "Genel", en: "General" },
  "nav.sectionInfo": { tr: "Bilgi", en: "Knowledge" },
  "nav.sectionWork": { tr: "Çalışma", en: "Work" },
  "nav.sectionSystem": { tr: "Sistem", en: "System" },
  "nav.dashboard": { tr: "Panel", en: "Dashboard" },
  "nav.rag": { tr: "RAG Yönetimi", en: "RAG Management" },
  "nav.prompts": { tr: "Prompt'lar", en: "Prompts" },
  "nav.memories": { tr: "Hafıza", en: "Memories" },
  "nav.projects": { tr: "Projeler", en: "Projects" },
  "nav.sessions": { tr: "Oturumlar", en: "Sessions" },
  "nav.timeline": { tr: "Zaman Akışı", en: "Timeline" },
  "nav.learning": { tr: "Öğrenme Notları", en: "Learning Notes" },
  "nav.machines": { tr: "Makineler", en: "Machines" },
  "nav.media": { tr: "Medya", en: "Media" },
  "nav.skills": { tr: "Skiller", en: "Skills" },
  "nav.settings": { tr: "Ayarlar", en: "Settings" },

  // --- common ---
  "common.save": { tr: "Kaydet", en: "Save" },
  "common.saving": { tr: "Kaydediliyor...", en: "Saving..." },
  "common.cancel": { tr: "Vazgeç", en: "Cancel" },
  "common.delete": { tr: "Sil", en: "Delete" },
  "common.deleting": { tr: "Siliniyor...", en: "Deleting..." },
  "common.edit": { tr: "Düzenle", en: "Edit" },
  "common.open": { tr: "Aç", en: "Open" },
  "common.close": { tr: "Kapat", en: "Close" },
  "common.new": { tr: "Yeni", en: "New" },
  "common.create": { tr: "Oluştur", en: "Create" },
  "common.back": { tr: "← Geri", en: "← Back" },
  "common.refresh": { tr: "Yenile", en: "Refresh" },
  "common.search": { tr: "Ara", en: "Search" },
  "common.searching": { tr: "Aranıyor...", en: "Searching..." },
  "common.loading": { tr: "Yükleniyor...", en: "Loading..." },
  "common.error": { tr: "Hata", en: "Error" },
  "common.name": { tr: "Ad", en: "Name" },
  "common.all": { tr: "Tümü", en: "All" },
  "common.title": { tr: "Başlık", en: "Title" },
  "common.content": { tr: "İçerik", en: "Content" },
  "common.project": { tr: "Proje", en: "Project" },
  "common.optional": { tr: "opsiyonel", en: "optional" },
  "common.notFound": { tr: "bulunamadı", en: "not found" },
  "common.confirmDeleteTitle": { tr: "Silinsin mi?", en: "Delete this?" },
  "common.actionIrreversible": { tr: "Bu işlem geri alınamaz.", en: "This action cannot be undone." },
  "common.savedToast": { tr: "Kaydedildi", en: "Saved" },
  "common.deletedToast": { tr: "Silindi", en: "Deleted" },
  "common.createdToast": { tr: "Oluşturuldu", en: "Created" },
  "common.saveFailed": { tr: "Kaydetme başarısız", en: "Save failed" },
  "common.deleteFailed": { tr: "Silme başarısız", en: "Delete failed" },
  "common.loadFailed": { tr: "Yükleme başarısız", en: "Load failed" },

  // --- settings ---
  "settings.title": { tr: "Ayarlar", en: "Settings" },
  "settings.tokenLabel": { tr: "API Token (sunucuda HUB_TOKEN doluysa gerekli)", en: "API Token (required if HUB_TOKEN is set on the server)" },
  "settings.saved": { tr: "Kaydedildi (tarayıcıda saklanır)", en: "Saved (stored in browser)" },
  "settings.language": { tr: "Dil", en: "Language" },

  // --- token gate ---
  "tokenGate.title": { tr: "Oturum gerekli", en: "Session required" },
  "tokenGate.description": { tr: "Sunucu bir API token'ı bekliyor (HUB_TOKEN). Devam etmek için token'ı gir.", en: "The server expects an API token (HUB_TOKEN). Enter it to continue." },
  "tokenGate.tokenLabel": { tr: "API Token", en: "API Token" },
  "tokenGate.placeholder": { tr: "hub token'ınız", en: "your hub token" },
  "tokenGate.connect": { tr: "Bağlan", en: "Connect" },
  "tokenGate.whereTitle": { tr: "Token'ı nereden bulurum?", en: "Where do I find the token?" },
  "tokenGate.whereDesc": { tr: "Pi üzerindeki sunucu ortam değişkeni HUB_TOKEN ile aynı değeri kullan.", en: "Use the same value as the HUB_TOKEN environment variable on the server." },

  // --- memories ---
  "memories.title": { tr: "Hafıza", en: "Memories" },
  "memories.newRecord": { tr: "Yeni kayıt", en: "New record" },
  "memories.searchPlaceholder": { tr: "Hibrit arama (anahtar kelime + anlamsal)...", en: "Hybrid search (keyword + semantic)..." },
  "memories.colType": { tr: "Tür", en: "Type" },
  "memories.colTitle": { tr: "Başlık", en: "Title" },
  "memories.colProject": { tr: "Proje", en: "Project" },
  "memories.colUpdated": { tr: "Güncelleme", en: "Updated" },
  "memories.editTitle": { tr: "düzenle", en: "edit" },
  "memories.newTitle": { tr: "Yeni hafıza kaydı", en: "New memory record" },
  "memories.type": { tr: "Tür", en: "Type" },
  "memories.tags": { tr: "Etiketler (virgülle ayır)", en: "Tags (comma-separated)" },
  "memories.body": { tr: "İçerik", en: "Content" },
  "memories.emptyTitleQuery": { tr: "Eşleşen kayıt yok", en: "No matching records" },
  "memories.emptyDescQuery": { tr: "Farklı kelimelerle dene — anlamsal arama eş anlamlıları da bulur.", en: "Try different words — semantic search also finds synonyms." },
  "memories.emptyTitle": { tr: "Henüz hafıza kaydı yok", en: "No memory records yet" },
  "memories.emptyDesc": { tr: "Agentlar çalıştıkça burası dolacak; elle de ekleyebilirsin.", en: "This fills up as agents work; you can also add entries manually." },
  "memories.confirmDeleteDesc": { tr: "Bu hafıza kaydı kalıcı olarak silinecek.", en: "This memory record will be permanently deleted." },
  "memories.deleteAction": { tr: "Kaydı sil", en: "Delete record" },

  // --- projects ---
  "projects.title": { tr: "Projeler", en: "Projects" },
  "projects.newProject": { tr: "Yeni proje", en: "New project" },
  "projects.name": { tr: "Proje adı", en: "Project name" },
  "projects.summary": { tr: "Özet", en: "Summary" },
  "projects.status": { tr: "Durum", en: "Status" },
  "projects.stack": { tr: "Stack (virgülle ayır)", en: "Stack (comma-separated)" },
  "projects.currentFocus": { tr: "Mevcut odak", en: "Current focus" },
  "projects.nextSteps": { tr: "Sıradaki adımlar (satır başına bir)", en: "Next steps (one per line)" },
  "projects.notes": { tr: "Notlar", en: "Notes" },
  "projects.noSummary": { tr: "Özet yok", en: "No summary" },
  "projects.decisions": { tr: "Karar geçmişi", en: "Decision history" },
  "projects.empty": { tr: "Kayıtlı proje yok", en: "No projects yet" },
  "projects.emptyDesc": { tr: "Agentlar project_update ile ekler; new-project skill'i otomatik oluşturur.", en: "Agents add these via project_update; the new-project skill creates them automatically." },
  "projects.unknownStatus": { tr: "bilinmiyor", en: "unknown" },
  "projects.confirmDeleteDesc": { tr: "kalıcı olarak silinecek. Bu işlem geri alınamaz.", en: "will be permanently deleted. This action cannot be undone." },
  "projects.deleteAction": { tr: "Projeyi sil", en: "Delete project" },
  "projects.newDialogTitle": { tr: "Yeni proje oluştur", en: "Create new project" },

  // --- sessions ---
  "sessions.title": { tr: "Oturum Geçmişi", en: "Session History" },
  "sessions.empty": { tr: "Oturum kaydı yok", en: "No session logs" },
  "sessions.emptyDesc": { tr: "Agentlar oturum sonunda session_log ile özet bırakır.", en: "Agents leave a summary via session_log at the end of a session." },
  "sessions.confirmDeleteDesc": { tr: "Bu oturum kaydı kalıcı olarak silinecek.", en: "This session log will be permanently deleted." },
  "sessions.deleteAction": { tr: "Kaydı sil", en: "Delete log" },

  // --- machines ---
  "machines.title": { tr: "Makineler", en: "Machines" },
  "machines.newMachine": { tr: "Yeni makine", en: "New machine" },
  "machines.name": { tr: "Ad", en: "Name" },
  "machines.host": { tr: "Host", en: "Host" },
  "machines.lmstudioPort": { tr: "LM Studio portu", en: "LM Studio port" },
  "machines.ollamaPort": { tr: "Ollama portu", en: "Ollama port" },
  "machines.comfyuiPort": { tr: "ComfyUI portu", en: "ComfyUI port" },
  "machines.notes": { tr: "Notlar", en: "Notes" },
  "machines.empty": { tr: "Kayıtlı makine yok", en: "No machines registered" },
  "machines.emptyDesc": { tr: "Agentlar machine_register ile ekler; buradan da ekleyebilirsin.", en: "Agents add these via machine_register; you can also add one here." },
  "machines.confirmDeleteDesc": { tr: "kalıcı olarak silinecek.", en: "will be permanently deleted." },
  "machines.deleteAction": { tr: "Makineyi sil", en: "Delete machine" },
  "machines.lmstudioOnline": { tr: "açık", en: "online" },
  "machines.lmstudioOffline": { tr: "kapalı", en: "offline" },
  "machines.models": { tr: "model", en: "models" },
  "machines.probing": { tr: "Servisler yoklanıyor...", en: "Probing services..." },
  "machines.newDialogTitle": { tr: "Yeni makine ekle", en: "Add new machine" },

  // --- skills ---
  "skills.title": { tr: "Skiller", en: "Skills" },
  "skills.newSkill": { tr: "Yeni skill", en: "New skill" },
  "skills.sourceNote": { tr: "Kaynak: repo/skills — düzenledikten sonra kalıcılık için git commit + push ve her cihazda `hub sync` gerekir.", en: "Source: repo/skills — after editing, git commit + push and `hub sync` on every device is required for persistence." },
  "skills.empty": { tr: "Skill bulunamadı", en: "No skills found" },
  "skills.emptyDesc": { tr: "Sunucu repo kökünden çalışmıyor olabilir (skills/ klasörü görünmüyor).", en: "The server may not be running from the repo root (skills/ folder not visible)." },
  "skills.name": { tr: "Skill adı (a-z, 0-9, -)", en: "Skill name (a-z, 0-9, -)" },
  "skills.aiDraft": { tr: "AI ile taslak üret", en: "Generate draft with AI" },
  "skills.aiDraftDialogTitle": { tr: "AI ile SKILL.md taslağı üret", en: "Generate SKILL.md draft with AI" },
  "skills.aiDraftPrompt": { tr: "Skill ne yapmalı? (kısa tarif)", en: "What should the skill do? (short description)" },
  "skills.aiDraftGenerate": { tr: "Üret", en: "Generate" },
  "skills.aiDraftGenerating": { tr: "Üretiliyor...", en: "Generating..." },
  "skills.aiDraftFailed": { tr: "Yerel LLM'e ulaşılamadı", en: "Could not reach local LLM" },
  "skills.aiDraftDone": { tr: "Taslak editöre yerleştirildi", en: "Draft placed in editor" },
  "skills.confirmDeleteDesc": { tr: "kalıcı olarak silinecek. Kaynak dosyalar diskten kaldırılır.", en: "will be permanently deleted. Source files will be removed from disk." },
  "skills.deleteAction": { tr: "Skill'i sil", en: "Delete skill" },
  "skills.newDialogTitle": { tr: "Yeni skill oluştur", en: "Create new skill" },

  // --- prompts ---
  "prompts.title": { tr: "Prompt Kütüphanesi", en: "Prompt Library" },
  "prompts.subtitle": { tr: "Master zihniyet çekirdeği + rol bazlı prompt'lar. Agentlar MCP üzerinden çeker.", en: "Master mindset core + role-based prompts. Agents fetch these via MCP." },
  "prompts.bannerTitle": { tr: "Master prompt her rol prompt'una otomatik eklenir", en: "The master prompt is automatically added to every role prompt" },
  "prompts.bannerDesc": { tr: "Böylece tüm alt modeller aynı temel disiplinle çalışır. Kaydetme kalıcı olması için sunucuda git commit + push, diğer cihazlarda git pull gerektirir.", en: "This way all sub-models work with the same core discipline. For saving to persist, git commit + push on the server and git pull on other devices is required." },
  "prompts.master": { tr: "Master", en: "Master" },
  "prompts.roles": { tr: "Roller", en: "Roles" },
  "prompts.noRoles": { tr: "Rol prompt'u yok", en: "No role prompts" },
  "prompts.noRolesDesc": { tr: "prompts/roles/ klasörüne .md dosyası ekleyerek yeni rol tanımlayabilirsin.", en: "Add a .md file to prompts/roles/ to define a new role." },
  "prompts.noDescription": { tr: "Açıklama yok", en: "No description" },
  "prompts.masterBannerTitle": { tr: "Master prompt tüm rollere otomatik eklenir", en: "The master prompt is automatically added to all roles" },
  "prompts.masterBannerDesc": { tr: "Her rol prompt'unun başına bu içerik dahil edilir. Buradaki bir değişiklik tüm rolleri etkiler.", en: "This content is prepended to every role prompt. A change here affects all roles." },
  "prompts.roleBannerTitle": { tr: "Bu rol prompt'u master ile otomatik birleştirilir", en: "This role prompt is automatically merged with the master" },
  "prompts.roleBannerDesc": { tr: "\"Birleşik önizleme\" sekmesi agent'ın gerçekte göreceği hali gösterir.", en: "The \"Composed preview\" tab shows what the agent actually sees." },
  "prompts.tabEdit": { tr: "Düzenle", en: "Edit" },
  "prompts.tabPreview": { tr: "Önizleme", en: "Preview" },
  "prompts.tabComposed": { tr: "Birleşik önizleme", en: "Composed preview" },
  "prompts.savedNote": { tr: "Prompt kaydedildi. Kalıcı olması için git commit + push gerekir.", en: "Prompt saved. git commit + push is required for it to persist." },
  "prompts.saveFailedNote": { tr: "Kaydetme başarısız", en: "Save failed" },
  "prompts.newRole": { tr: "Yeni rol", en: "New role" },
  "prompts.newDialogTitle": { tr: "Yeni rol prompt'u oluştur", en: "Create new role prompt" },
  "prompts.roleName": { tr: "Rol adı (ör. backend-engineer)", en: "Role name (e.g. backend-engineer)" },
  "prompts.roleDescription": { tr: "Kısa açıklama", en: "Short description" },

  // --- rag ---
  "rag.title": { tr: "RAG Yönetimi", en: "RAG Management" },
  "rag.subtitle": { tr: "Doküman kaynakları, embedding durumu ve arama testleri", en: "Document sources, embedding status, and search tests" },
  "rag.reindexDone": { tr: "Eksikleri tamamla", en: "Complete missing" },
  "rag.reindexing": { tr: "İndeksleniyor...", en: "Indexing..." },
  "rag.forceReindex": { tr: "Zorla yeniden indeksle", en: "Force reindex" },
  "rag.searchTestTitle": { tr: "Arama testi", en: "Search test" },
  "rag.searchTestDesc": { tr: "Agent'ın hibrit aramada göreceği sonucu burada canlı dene.", en: "Try live what the agent sees in hybrid search here." },
  "rag.searchPlaceholder": { tr: "Örn: sqlite-vec kurulumu...", en: "E.g.: sqlite-vec setup..." },
  "rag.noResults": { tr: "Sonuç bulunamadı.", en: "No results found." },
  "rag.score": { tr: "skor", en: "score" },
  "rag.docDeletedConfirm": { tr: "Doküman silinsin mi?", en: "Delete this document?" },
  "rag.docDeleteDesc": { tr: "ve tüm chunk'ları kalıcı olarak silinecek. Bu işlem geri alınamaz.", en: "and all its chunks will be permanently deleted. This action cannot be undone." },
  "rag.deleteDoc": { tr: "Dokümanı sil", en: "Delete document" },
  "rag.forceReindexConfirmTitle": { tr: "Zorla yeniden indekslensin mi?", en: "Force reindex everything?" },
  "rag.forceReindexConfirmDesc": { tr: "Tüm dokümanlar ve hafıza kayıtları sıfırdan yeniden embed edilecek. Doküman sayısına göre uzun sürebilir ve embedding API kotasını tüketebilir.", en: "All documents and memory records will be re-embedded from scratch. This can take a while and consume embedding API quota depending on document count." },
  "rag.colChunk": { tr: "Chunk", en: "Chunks" },
  "rag.colCreated": { tr: "Eklenme", en: "Created" },
  "rag.docActive": { tr: "Aktif", en: "Active" },
  "rag.docDisabled": { tr: "Kapalı", en: "Disabled" },
  "rag.uriMissing": { tr: "URI yok", en: "No URI" },
  "rag.projectMissing": { tr: "proje yok", en: "no project" },
  "rag.noChunks": { tr: "Bu dokümanda henüz chunk yok.", en: "This document has no chunks yet." },
  "rag.empty": { tr: "Doküman yok", en: "No documents" },
  "rag.emptyDesc": { tr: "RAG'e agentlar rag_add ile ekler; buradan yönetebilirsin.", en: "Agents add to RAG via rag_add; you can manage them here." },
  "rag.addDocument": { tr: "Doküman ekle", en: "Add document" },
  "rag.addDialogTitle": { tr: "Yeni doküman ekle", en: "Add new document" },
  "rag.docTitle": { tr: "Başlık", en: "Title" },
  "rag.docText": { tr: "Metin", en: "Text" },
  "rag.docUri": { tr: "URI", en: "URI" },

  // --- learning ---
  "learning.title": { tr: "Öğrenme Notları", en: "Learning Notes" },
  "learning.subtitle": { tr: "learn skill'i ve rag_add ile eklenen öğrenme kaynakları", en: "Learning resources added via the learn skill and rag_add" },
  "learning.searchPlaceholder": { tr: "Öğrenme notlarında ara...", en: "Search learning notes..." },
  "learning.searchResultsTitle": { tr: "Arama sonuçları", en: "Search results" },
  "learning.backToList": { tr: "← Listeye dön", en: "← Back to list" },
  "learning.empty": { tr: "Henüz öğrenme notu yok", en: "No learning notes yet" },
  "learning.emptyDesc": { tr: "learn skill'i veya rag_add ile project=learning olarak eklenen dokümanlar burada listelenir.", en: "Documents added via the learn skill or rag_add with project=learning appear here." },
  "learning.noResults": { tr: "Eşleşen not bulunamadı.", en: "No matching notes found." },
  "learning.chunkCount": { tr: "chunk", en: "chunks" },
  "learning.noChunks": { tr: "Bu notta henüz chunk yok.", en: "This note has no chunks yet." },

  // --- media ---
  "media.title": { tr: "Medya Üretimi", en: "Media Generation" },
  "media.promptLabel": { tr: "Prompt (İngilizce daha iyi sonuç verir)", en: "Prompt (English works better)" },
  "media.generate": { tr: "Üret", en: "Generate" },
  "media.generating": { tr: "Üretiliyor...", en: "Generating..." },
  "media.generatingNote": { tr: "Üretiliyor... (model ilk yüklemede dakikalar sürebilir)", en: "Generating... (first model load can take minutes)" },
  "media.done": { tr: "Tamamlandı", en: "Done" },
  "media.outputs": { tr: "Çıktılar", en: "Outputs" },
  "media.error": { tr: "Hata", en: "Error" },
  "media.placeholder": { tr: "a minimal flat illustration of ...", en: "a minimal flat illustration of ..." },

  // --- timeline ---
  "timeline.title": { tr: "Zaman Akışı", en: "Timeline" },
  "timeline.subtitle": { tr: "Hafıza, oturum ve dokümanlar tek zaman ekseninde", en: "Memories, sessions, and documents on a single time axis" },
  "timeline.filterAll": { tr: "Hepsi", en: "All" },
  "timeline.kindMemory": { tr: "Hafıza", en: "Memory" },
  "timeline.kindSession": { tr: "Oturum", en: "Session" },
  "timeline.kindDocument": { tr: "Doküman", en: "Document" },
  "timeline.loadMore": { tr: "Daha fazla yükle", en: "Load more" },
  "timeline.end": { tr: "Akışın sonu", en: "End of timeline" },
  "timeline.empty": { tr: "Zaman akışı boş", en: "Timeline is empty" },
  "timeline.emptyDesc": { tr: "Hafıza kayıtları, oturumlar ve dokümanlar eklendikçe burada görünecek.", en: "Memory records, sessions, and documents will appear here as they are added." },
  "timeline.emptyFiltered": { tr: "Bu türde kayıt yok", en: "No records of this type" },
  "timeline.emptyFilteredDesc": { tr: "Filtreyi değiştir veya daha fazla kayıt yükle.", en: "Change the filter or load more records." },
  "timeline.today": { tr: "Bugün", en: "Today" },
  "timeline.yesterday": { tr: "Dün", en: "Yesterday" },

  // --- dashboard ---
  "dashboard.title": { tr: "Panel", en: "Dashboard" },
  "dashboard.subtitle": { tr: "Ortak hafıza sisteminin genel durumu", en: "Overall status of the shared memory system" },
  "dashboard.loadFailed": { tr: "Panel yüklenemedi", en: "Dashboard failed to load" },
  "dashboard.server": { tr: "Sunucu", en: "Server" },
  "dashboard.running": { tr: "Çalışıyor", en: "Running" },
  "dashboard.unreachable": { tr: "Erişilemiyor", en: "Unreachable" },
  "dashboard.online": { tr: "Çevrimiçi", en: "Online" },
  "dashboard.offline": { tr: "Kapalı", en: "Offline" },
  "dashboard.database": { tr: "Veritabanı", en: "Database" },
  "dashboard.vectorSearch": { tr: "Vektör arama", en: "Vector search" },
  "dashboard.vecActive": { tr: "Aktif", en: "Active" },
  "dashboard.vecFtsOnly": { tr: "FTS-only", en: "FTS-only" },
  "dashboard.vecActiveDesc": { tr: "sqlite-vec aktif", en: "sqlite-vec active" },
  "dashboard.vecInactiveDesc": { tr: "Sadece anahtar kelime", en: "Keyword only" },
  "dashboard.embeddingOff": { tr: "Embedding kapalı (GEMINI_API_KEY yok)", en: "Embedding disabled (no GEMINI_API_KEY)" },
  "dashboard.sync": { tr: "Eşitleme", en: "Sync" },
  "dashboard.peerMode": { tr: "Peer modu", en: "Peer mode" },
  "dashboard.standaloneMode": { tr: "Bağımsız (primary)", en: "Standalone (primary)" },
  "dashboard.noPrimaryUrl": { tr: "HUB_PRIMARY_URL tanımlı değil", en: "HUB_PRIMARY_URL not set" },
  "dashboard.documents": { tr: "Dokümanlar", en: "Documents" },
  "dashboard.total": { tr: "Toplam", en: "Total" },
  "dashboard.active": { tr: "Aktif", en: "Active" },
  "dashboard.disabled": { tr: "Kapalı", en: "Disabled" },
  "dashboard.chunkEmbedRatio": { tr: "Chunk embedding oranı", en: "Chunk embedding ratio" },
  "dashboard.memoryEmbedRatio": { tr: "Hafıza embedding oranı", en: "Memory embedding ratio" },
  "dashboard.chunksHave": { tr: "chunk embedding'e sahip", en: "chunks have embeddings" },
  "dashboard.recordsHave": { tr: "kayıt embedding'e sahip", en: "records have embeddings" },
  "dashboard.peerStatus": { tr: "Peer eşitleme durumu", en: "Peer sync status" },
  "dashboard.lastPull": { tr: "Son pull", en: "Last pull" },
  "dashboard.lastPush": { tr: "Son push", en: "Last push" },
  "dashboard.never": { tr: "hiç", en: "never" },
  "dashboard.justNow": { tr: "az önce", en: "just now" },
  "dashboard.minutesAgo": { tr: "dk önce", en: "min ago" },
  "dashboard.hoursAgo": { tr: "sa önce", en: "h ago" },
  "dashboard.daysAgo": { tr: "gün önce", en: "d ago" },
  "dashboard.growthTitle": { tr: "Bilgi büyümesi", en: "Knowledge growth" },
  "dashboard.growthSubtitle": { tr: "Son 90 gün — kümülatif kayıt sayısı", en: "Last 90 days — cumulative record count" },
  "dashboard.growthEmpty": { tr: "Henüz büyüme verisi yok", en: "No growth data yet" },
  "dashboard.growthEmptyDesc": { tr: "Hafıza, oturum ve doküman kayıtları eklendikçe grafik burada oluşacak.", en: "The chart will appear here as memory, session, and document records are added." },
  "dashboard.seriesMemories": { tr: "Hafıza", en: "Memories" },
  "dashboard.seriesSessions": { tr: "Oturumlar", en: "Sessions" },
  "dashboard.seriesDocuments": { tr: "Dokümanlar", en: "Documents" },
  "dashboard.chunksLabel": { tr: "chunk", en: "chunks" },
  "dashboard.recentSessions": { tr: "Son oturumlar", en: "Recent sessions" },
  "dashboard.noSessions": { tr: "Henüz oturum kaydı yok", en: "No session logs yet" },
  "dashboard.noSessionsDesc": { tr: "Agentlar oturum sonunda session_log ile özet bırakır.", en: "Agents leave a summary via session_log at the end of a session." },
  "dashboard.usageTitle": { tr: "Kullanım", en: "Usage" },
  "dashboard.usageTopTitle": { tr: "En çok başvurulan hafızalar", en: "Most accessed memories" },
  "dashboard.usageTopEmpty": { tr: "Henüz kullanım verisi yok", en: "No usage data yet" },
  "dashboard.usageStaleTitle": { tr: "Uzun süredir erişilmeyen", en: "Not accessed in a while" },
  "dashboard.usageStaleRecords": { tr: "kayıt uzun süredir erişilmedi", en: "records not accessed in a while" },
  "dashboard.usageStaleEmpty": { tr: "Uzun süredir erişilmeyen kayıt yok", en: "No stale records" },
  "dashboard.usageShowList": { tr: "Listeyi göster", en: "Show list" },
  "dashboard.usageAccessCount": { tr: "erişim", en: "accesses" },
  "dashboard.usageLastAccessed": { tr: "Son erişim", en: "Last accessed" },
  "dashboard.heroBadge": { tr: "Canlı genel bakış", en: "Live overview" },
  "dashboard.heroTitleLine1": { tr: "Ortak hafızanın", en: "Your shared" },
  "dashboard.heroTitleLine2": { tr: "nabzı", en: "memory, live" },
  "dashboard.heroCaption": { tr: "Hafıza, oturum ve doküman büyümenizi tek bakışta izleyin.", en: "Track your memory, session, and document growth at a glance." },
} satisfies Record<string, Record<Lang, string>>;

export type TKey = keyof typeof dict;

export function translate(key: TKey, lang: Lang): string {
  return dict[key]?.[lang] ?? String(key);
}

// --- React context: tüm view'lar dil değişikliğine tepki versin ---

export interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TKey) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useProvideI18n(): I18nContextValue {
  const [lang, setLangState] = useState<Lang>(getLang());
  const setLang = useCallback((next: Lang) => {
    setStoredLang(next);
    setLangState(next);
  }, []);
  const t = useCallback((key: TKey) => translate(key, lang), [lang]);
  return { lang, setLang, t };
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nContext.Provider");
  return ctx;
}

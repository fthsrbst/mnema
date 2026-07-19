import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Sadece dev: /api istekleri lokal hub backend'ine (npm run dev, port 8033) gider.
    // Üretimde web build'i backend Express'ten aynı origin'de servis edilir — proxy devre dışıdır.
    proxy: {
      '/api': 'http://127.0.0.1:8033',
      // Dashboard /health'i doğrudan çağırır; üretimde aynı origin'den gelir,
      // dev'de proxy'lenmezse SPA index.html'ine düşüp JSON parse hatası verir.
      '/health': 'http://127.0.0.1:8033',
    },
  },
})

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 網址為 https://<帳號>.github.io/order_tracking/
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/order_tracking/',
  plugins: [react()],
});

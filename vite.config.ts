import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * GDPR. The wallet-selector modal stylesheet @imports Inter from fonts.googleapis.com, which leaks visitor IPs
 * to Google. We self-host Inter (@fontsource-variable/inter). This drops the import and points the modal at it.
 */
const noGoogleFonts = (): Plugin => ({
  name: "no-google-fonts",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("@near-wallet-selector/modal-ui") || !id.endsWith(".css")) return;
    return code
      .replace(/@import\s+url\(["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g, "")
      .replace(/font-family:\s*Inter,/g, 'font-family: "Inter Variable",');
  },
});

export default defineConfig({
  root: "web",
  plugins: [noGoogleFonts(), react()],
  define: { global: "globalThis" },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "../dist", emptyOutDir: true },
});

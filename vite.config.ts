import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { resolve } from "path";

/** Deploy the SPA at the site root of https://console.maintafox.systems/ (default "/"). */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@shared": resolve(__dirname, "./shared"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    css: true,
    // Dialog + step-up flows type many characters in jsdom; 5 s (default) is too tight on a busy
    // machine or CI runner, a hung test still fails.
    testTimeout: 15_000,
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
  base: process.env.VITE_BASE_PATH ?? "/",
});

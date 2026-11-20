import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = new URL(process.env.CHATHUB_API_ORIGIN ?? "");
if (apiOrigin.protocol !== "https:" || apiOrigin.href !== apiOrigin.origin + "/") {
  throw new Error("CHATHUB_API_ORIGIN must be an HTTPS origin");
}
const base = process.env.CHATHUB_BASE ?? "/";
export default defineConfig({
  base,
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  define: {
    __CHATHUB_API_ORIGIN__: JSON.stringify(apiOrigin.origin),
    __CHATHUB_BASE__: JSON.stringify(base),
  },
  build: { outDir: "dist-pages" },
});

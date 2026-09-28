import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { aiApi } from "./server/aiApi.ts";
import { libraryApi } from "./server/libraryApi.ts";
import { projectsApi } from "./server/projectsApi.ts";

export default defineConfig({
  plugins: [react(), projectsApi({ projectsDir: resolve(import.meta.dirname, "projects") }), libraryApi(), aiApi()],
  build: {
    rollupOptions: {
      input: {
        editor: resolve(import.meta.dirname, "index.html"),
        render: resolve(import.meta.dirname, "render.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});

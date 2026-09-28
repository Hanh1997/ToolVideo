import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { RegistrySchema } from "../src/schemas/asset.schema";
import { resolveScene, type Synthesize } from "../src/tts/resolveScene";
import { createPiperTts, readRegistryFile } from "./tts/piperTts";

const PROJECT_ID = /^[a-z0-9_-]+$/;
const MAX_BODY = 5 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Body quá lớn"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function listProjects(dir: string): Promise<{ id: string; name: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const result: { id: string; name: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !PROJECT_ID.test(e.name)) continue;
    let name = e.name;
    try {
      const meta = JSON.parse(await readFile(join(dir, e.name, "project.json"), "utf8")) as { name?: unknown };
      if (typeof meta.name === "string") name = meta.name;
    } catch {
      // project.json là tùy chọn
    }
    result.push({ id: e.name, name });
  }
  return result;
}

/**
 * API project cho MVP, chạy trong Vite dev server:
 *   GET /api/projects · GET /api/projects/:id/scene · PUT /api/projects/:id/scene
 * scene.json là nguồn dữ liệu duy nhất; validate đầy đủ nằm ở client/renderer.
 */
export function projectsApi(options: { projectsDir: string }): Plugin {
  const { projectsDir } = options;
  let tts: Synthesize | undefined;
  return {
    name: "autocartoon-projects-api",
    configureServer(server) {
      // POST /api/resolve: scene soạn thảo → scene đã resolve (TTS lời thoại có cache, sync, duration auto).
      server.middlewares.use("/api/resolve", (req, res, next) => {
        if (req.method !== "POST") return next();
        void (async () => {
          let raw: unknown;
          try {
            raw = JSON.parse(await readBody(req));
          } catch {
            return send(res, 400, { error: "InvalidJson" });
          }
          const registry = RegistrySchema.parse(await readRegistryFile());
          tts ??= createPiperTts();
          send(res, 200, await resolveScene(raw, registry, tts));
        })().catch((err: unknown) => send(res, 500, { error: String(err) }));
      });

      server.middlewares.use("/api/projects", (req, res, next) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const parts = url.pathname.split("/").filter(Boolean);

          if (parts.length === 0 && req.method === "GET") {
            return send(res, 200, await listProjects(projectsDir));
          }

          const [id, resource] = parts;
          if (!id || !PROJECT_ID.test(id) || resource !== "scene" || parts.length !== 2) return next();
          const file = join(projectsDir, id, "scene.json");

          if (req.method === "GET") {
            try {
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(await readFile(file, "utf8"));
            } catch {
              send(res, 404, { error: "ProjectNotFound", id });
            }
            return;
          }

          if (req.method === "PUT") {
            const body = await readBody(req);
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              return send(res, 400, { error: "InvalidJson" });
            }
            await mkdir(join(projectsDir, id), { recursive: true });
            await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
            return send(res, 200, { ok: true });
          }

          next();
        })().catch((err: unknown) => send(res, 500, { error: String(err) }));
      });
    },
  };
}

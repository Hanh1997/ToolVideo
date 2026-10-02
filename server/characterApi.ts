/**
 * API "Tạo nhân vật bằng mô tả" (Vite dev server, chỉ localhost):
 *
 *   GET  /api/chargen/status                 AI đã cấu hình chưa, có Blender / thư viện Mixamo không
 *   POST /api/chargen/design {prompt}        → {spec, note?}  (AI thiết kế, chưa dựng)
 *   POST /api/chargen/design {base, instruction} → spec sửa theo góp ý
 *   POST /api/chargen/build  {spec, prompt?, id?} → job dựng (id = dựng lại nhân vật đã tạo)
 *   GET  /api/chargen/job                    tiến độ job gần nhất
 *   POST /api/chargen/job/cancel
 *   GET  /api/chargen/saved                  mọi nhân vật AI đã tạo (chọn làm gốc cho nhân vật mới)
 *   POST /api/chargen/design {base, instruction, fromBase: true} → nhân vật MỚI phát triển từ nhân vật gốc
 *   GET  /api/chargen/saved/:id              spec + prompt đã lưu của nhân vật do AI tạo
 *   GET  /api/chargen/preview/:id/:file      preview.png | preview_face.png
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { normalizeCharacterSpec } from "../src/ai/characterSpec";
import { cancelJob, CHAR_STORAGE, currentJob, designCharacter, findBlender, GEN_ID, listSaved, loadSaved, mixamoLibrary, startBuild } from "./ai/characterGenerator";
import { aiConfigured, AiError } from "./ai/deepseek";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

export function characterApi(): Plugin {
  return {
    name: "autocartoon-character-api",
    configureServer(server) {
      server.middlewares.use("/api/chargen", (req, res, next) => {
        const p = new URL(req.url ?? "/", "http://localhost").pathname;
        const route = async (): Promise<unknown> => {
          if (p === "/status" && req.method === "GET") {
            const mixamo = mixamoLibrary();
            return send(res, 200, { ai: aiConfigured(), blender: findBlender() ?? null, mixamoClips: mixamo?.clips ?? 0 });
          }
          if (p === "/design" && req.method === "POST") {
            const body = await readJson<{ prompt?: string; base?: unknown; instruction?: string; fromBase?: boolean }>(req);
            if (body.base !== undefined) {
              const instruction = (body.instruction ?? "").trim();
              if (instruction.length < 2) return send(res, 400, { error: body.fromBase ? "Nhập mô tả nhân vật mới" : "Nhập nội dung cần sửa" });
              return send(res, 200, await designCharacter("", { base: normalizeCharacterSpec(body.base), instruction, fromBase: body.fromBase === true }));
            }
            const prompt = (body.prompt ?? "").trim();
            if (prompt.length < 3) return send(res, 400, { error: "Mô tả quá ngắn" });
            return send(res, 200, await designCharacter(prompt));
          }
          if (p === "/build" && req.method === "POST") {
            const body = await readJson<{ spec?: unknown; prompt?: string; id?: string }>(req);
            if (!body.spec) return send(res, 400, { error: "Thiếu spec" });
            return send(res, 200, await startBuild(body.spec, { prompt: body.prompt?.trim() || undefined, id: body.id || undefined }));
          }
          if (p === "/job" && req.method === "GET") return send(res, 200, currentJob() ?? null);
          if (p === "/job/cancel" && req.method === "POST") {
            return cancelJob() ? send(res, 200, { ok: true }) : send(res, 409, { error: "Không có job đang chạy" });
          }
          if (p === "/saved" && req.method === "GET") {
            return send(res, 200, (await listSaved()).map((s) => ({ assetId: s.assetId, name: s.spec.name, spec: s.spec })));
          }
          const saved = /^\/saved\/([^/]+)$/.exec(p);
          if (saved && req.method === "GET") {
            const s = await loadSaved(decodeURIComponent(saved[1]!));
            return s ? send(res, 200, s) : send(res, 404, { error: "Không có bản mô tả đã lưu" });
          }
          const prev = /^\/preview\/([^/]+)\/(preview(?:_face)?\.png)$/.exec(p);
          if (prev && req.method === "GET") {
            const id = decodeURIComponent(prev[1]!);
            const file = join(CHAR_STORAGE, id, prev[2]!);
            if (!GEN_ID.test(id) || !existsSync(file)) return send(res, 404, { error: "Chưa có ảnh xem trước" });
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "no-store");
            return res.end(await readFile(file));
          }
          return next();
        };
        route().catch((err: unknown) => send(res, err instanceof AiError ? 502 : 400, { error: err instanceof Error ? err.message : String(err) }));
      });
    },
  };
}

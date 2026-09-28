/**
 * Render CLI: scene.json (hoặc movie.json – nhiều khung cảnh) → MP4, không cần UI.
 *
 *   npm run render -- projects/demo-robot-park
 *   npm run render -- projects/demo-robot-park --width 1080 --height 1920 --keep-frames
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRenderEnv, parseQualityMode, parseRendererMode, prepareScene, RenderFailure, renderScene, writeFailureRecord } from "./renderJob";
import { loadMovie, prepareMovie, renderMovie, resolvedMovieJson } from "./renderMovie";

const log = (msg: string) => console.log(`[render] ${msg}`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: "string" },
    height: { type: "string" },
    fps: { type: "string" },
    out: { type: "string" },
    "keep-frames": { type: "boolean", default: false },
    browser: { type: "string", default: "chromium" },
    /** auto (mặc định: GPU nếu có) | gpu | cpu. Cũng đặt được bằng biến môi trường AC_RENDERER. */
    renderer: { type: "string" },
    /** auto (mặc định: high nếu GPU, standard nếu CPU) | high | standard. Hoặc biến AC_QUALITY. */
    quality: { type: "string" },
    crf: { type: "string" },
  },
});

const projectArg = positionals[0];
if (!projectArg) {
  console.error("Cách dùng: npm run render -- <thư mục project> [--width W --height H --fps N --out file.mp4 --keep-frames --renderer auto|gpu|cpu]");
  process.exit(2);
}

const projectDir = resolve(process.cwd(), projectArg);
const projectId = basename(projectDir);
const renderId = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const output = values.out ? resolve(process.cwd(), values.out) : join(projectDir, "renders", `${renderId}.mp4`);

let cancelled = false;
process.on("SIGINT", () => {
  cancelled = true;
  log("Đang hủy…");
});

const env = await createRenderEnv({ browser: values.browser, renderer: parseRendererMode(values.renderer), quality: parseQualityMode(values.quality), log });
const overrides = {
  width: values.width ? Number(values.width) : undefined,
  height: values.height ? Number(values.height) : undefined,
  fps: values.fps ? Number(values.fps) : undefined,
};
let exitCode = 1;
try {
  if (existsSync(join(projectDir, "movie.json"))) {
    // Movie: nhiều khung cảnh → một video.
    const pm = await prepareMovie(env, await loadMovie(projectDir), overrides, log);
    await writeFile(join(projectDir, "movie.resolved.json"), `${JSON.stringify(resolvedMovieJson(pm), null, 2)}\n`, "utf8");
    log(`${pm.movie.meta.name}: ${pm.scenes.length} cảnh, ${pm.timeline.duration}s`);
    const record = await renderMovie(env, pm, {
      projectId,
      output,
      crf: values.crf ? Number(values.crf) : undefined,
      keepFrames: values["keep-frames"],
      isCancelled: () => cancelled,
      log,
    });
    if (record.status === "Completed") {
      log(`✓ Xong: ${record.output} (${record.elapsedSeconds}s)`);
      exitCode = 0;
    } else {
      console.error(`[render] ✗ ${record.error?.code ?? record.status}\n${record.error?.message ?? ""}`);
    }
    process.exitCode = exitCode;
  } else {
    exitCode = await renderSingle();
  }
} catch (err) {
  const code = err instanceof RenderFailure ? err.code : "RenderFailed";
  await writeFailureRecord(projectId, output, err).catch(() => undefined);
  console.error(`[render] ✗ ${code}\n${err instanceof Error ? err.message : String(err)}`);
} finally {
  await env.close();
}
process.exit(exitCode);

async function renderSingle(): Promise<number> {
  const raw: unknown = JSON.parse(await readFile(join(projectDir, "scene.json"), "utf8"));
  const prepared = await prepareScene(env, raw, overrides, log);
  if (prepared.input !== raw) {
    // Lưu bản đã resolve để tái lập / kiểm tra (không ghi đè scene.json).
    await writeFile(join(projectDir, "scene.resolved.json"), `${JSON.stringify(prepared.input, null, 2)}
`, "utf8");
  }
  log(`${prepared.scene.meta.name} (${prepared.scene.meta.duration}s)`);

  const { record } = await renderScene(env, prepared, {
    projectId,
    output,
    crf: values.crf ? Number(values.crf) : undefined,
    keepFrames: values["keep-frames"],
    isCancelled: () => cancelled,
    log,
  });
  if (record.status === "Completed") {
    log(`✓ Xong: ${record.output} (${record.elapsedSeconds}s)`);
    return 0;
  }
  console.error(`[render] ✗ ${record.error?.code ?? record.status}
${record.error?.message ?? ""}`);
  return 1;
}

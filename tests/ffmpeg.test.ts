import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEncodeArgs, frameFileName } from "../cli/ffmpeg";

describe("ffmpeg", () => {
  it("tên frame zero-padding, bắt đầu từ 1", () => {
    expect(frameFileName(0)).toBe("frame_000001.png");
    expect(frameFileName(299)).toBe("frame_000300.png");
  });

  it("args an toàn: mảng, có -start_number 1, yuv420p, libx264", () => {
    const args = buildEncodeArgs({ framesDir: "frames dir; rm -rf /", fps: 30, output: "out file.mp4" });
    expect(args).toContain("-start_number");
    expect(args[args.indexOf("-start_number") + 1]).toBe("1");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-framerate") + 1]).toBe("30");
    // Đường dẫn có ký tự đặc biệt vẫn là MỘT argument, không bị shell diễn giải.
    expect(args.at(-1)).toBe("out file.mp4");
    expect(args[args.indexOf("-i") + 1]).toBe(join("frames dir; rm -rf /", "frame_%06d.png"));
  });
});

describe("chọn bộ render", () => {
  it("parseRendererMode: mặc định auto, nhận gpu/cpu, từ chối giá trị lạ", async () => {
    const { parseRendererMode, isSoftwareRenderer } = await import("../cli/renderJob");
    const prev = process.env.AC_RENDERER;
    delete process.env.AC_RENDERER;
    expect(parseRendererMode(undefined)).toBe("auto");
    expect(parseRendererMode("GPU")).toBe("gpu");
    expect(parseRendererMode("cpu")).toBe("cpu");
    expect(() => parseRendererMode("cuda")).toThrow();
    process.env.AC_RENDERER = "cpu";
    expect(parseRendererMode(undefined)).toBe("cpu");
    if (prev === undefined) delete process.env.AC_RENDERER;
    else process.env.AC_RENDERER = prev;

    expect(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRenderer("")).toBe(true);
  });
});

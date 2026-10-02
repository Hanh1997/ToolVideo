import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { eyeClosure, Eyelids, findEyes } from "../src/engine/Blink";

describe("chớp mắt – nhịp", () => {
  const sample = (id: string, emotion?: Parameters<typeof eyeClosure>[2]) => Array.from({ length: 60 * 60 }, (_, i) => eyeClosure(id, i / 60, emotion));

  it("chớp tự nhiên: 12–30 lần mỗi phút, nhắm hẳn rồi mở, tất định", () => {
    const v = sample("fox");
    let blinks = 0;
    for (let i = 1; i < v.length; i++) if (v[i]! >= 0.99 && v[i - 1]! < 0.99) blinks++;
    expect(blinks).toBeGreaterThanOrEqual(12);
    expect(blinks).toBeLessThanOrEqual(30);
    expect(Math.min(...v)).toBe(0);
    expect(sample("fox")).toEqual(v);
  });

  it("mỗi nhân vật chớp lệch nhịp nhau", () => {
    const a = sample("fox");
    const b = sample("bunny");
    const both = a.filter((x, i) => x > 0.5 && b[i]! > 0.5).length;
    expect(both).toBeLessThan(a.filter((x) => x > 0.5).length / 2);
  });

  it("buồn → sụp mí; ngạc nhiên → mở to, gần như không chớp", () => {
    expect(eyeClosure("fox", 0.1, { kind: "sad", weight: 1 })).toBeCloseTo(0.35, 5);
    const wide = sample("fox", { kind: "surprised", weight: 1 });
    expect(Math.max(...wide)).toBeLessThan(0.25);
  });
});

describe("chớp mắt – dò mắt trên model", () => {
  /** Mặt phẳng z = 0.5: nền da cam, hai mắt (tròng trắng + con ngươi đen) đối xứng. */
  function head(): THREE.Group {
    const g = new THREE.Group();
    const quad = (x0: number, y0: number, x1: number, y1: number, color: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([x0, y0, 0.5, x1, y0, 0.5, x1, y1, 0.5, x0, y0, 0.5, x1, y1, 0.5, x0, y1, 0.5], 3));
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color })));
    };
    quad(-0.6, 0, 0.6, 1.2, 0xe08040); // mặt (da)
    for (const s of [1, -1]) {
      const [a, b] = s > 0 ? [0.1, 0.4] : [-0.4, -0.1];
      quad(a, 0.7, b, 0.9, 0xf4f4f8); // tròng trắng
      quad(a, 0.55, b, 0.7, 0x202028); // con ngươi (chung cạnh y = 0.7)
    }
    quad(-0.08, 0.3, 0.08, 0.42, 0x202028); // mũi ở giữa – không phải mắt
    g.updateMatrixWorld(true);
    return g;
  }

  it("tìm đúng hai mắt (bỏ mũi ở giữa), màu da lấy quanh mắt", () => {
    const eyes = findEyes(head());
    expect(eyes).toHaveLength(2);
    const xs = eyes.map((e) => e.center.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-0.25, 2);
    expect(xs[1]).toBeCloseTo(0.25, 2);
    for (const e of eyes) {
      expect(e.center.y).toBeCloseTo(0.725, 2);
      expect(e.normal.z).toBeCloseTo(1, 5);
      expect(e.halfH).toBeGreaterThan(0.17);
      expect(e.skin[0]).toBeGreaterThan(0.8); // cam
    }
  });

  it("mí mắt: ẩn khi mở, che từ mép trên xuống khi nhắm", () => {
    const model = head();
    const lids = new Eyelids(findEyes(model));
    expect(lids.count).toBe(2);
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => o.name === "eyelid" && meshes.push(o as THREE.Mesh));
    lids.set(0);
    expect(meshes.every((m) => !m.visible)).toBe(true);
    lids.set(1);
    model.updateMatrixWorld(true);
    const lid = meshes.find((m) => (m.material as THREE.MeshStandardMaterial).color.r > 0.5)!;
    const box = new THREE.Box3().setFromObject(lid);
    expect(box.max.y).toBeCloseTo(0.9, 1);
    expect(box.min.y).toBeLessThan(0.57);
    expect(box.min.z).toBeGreaterThan(0.5); // nằm trước mặt
  });

  it("không có cặp mắt rõ ràng → không gắn mí", () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 })));
    expect(findEyes(g)).toEqual([]);
  });
});

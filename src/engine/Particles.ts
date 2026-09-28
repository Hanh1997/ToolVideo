import * as THREE from "three";
import type { Vec3, WeatherEffect } from "../schemas/scene.schema";

/**
 * Hiệu ứng hạt tất định: vị trí mỗi hạt là hàm của (seed, i, t) → seek tùy ý, preview = video.
 * Hạt nằm trong một khối quanh tâm sân khấu của cảnh (điểm nhìn của camera mặc định).
 */

interface Spec {
  count: number;
  /** Nửa cạnh khối (x/z) và chiều cao. */
  half: number;
  height: number;
  geometry: () => THREE.BufferGeometry;
  material: () => THREE.Material;
  colors?: string[];
  /** Chỉ sinh ở nửa khối phía xa camera mặc định (vật to như bướm: tránh bay sát ống kính). */
  farSide?: boolean;
  /** Ma trận của hạt i tại t (đã có vị trí gốc trong khối). */
  place: (i: number, t: number, base: THREE.Vector3, r: number, out: THREE.Object3D) => void;
}

const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const wrap = (v: number, h: number) => ((v % h) + h) % h;

const SPECS: Record<WeatherEffect, Spec> = {
  snow: {
    count: 3200,
    half: 14,
    height: 9,
    geometry: () => new THREE.IcosahedronGeometry(0.05, 0),
    material: () => new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, fog: true }),
    place: (i, t, b, r, o) => {
      const fall = 0.6 + 0.5 * r;
      o.position.set(b.x + Math.sin(t * (0.6 + r) + i) * 0.35, 9 - wrap(b.y + t * fall, 9), b.z + Math.cos(t * 0.5 + i * 0.7) * 0.3);
      o.scale.setScalar(0.7 + 0.8 * r);
    },
  },
  rain: {
    count: 1800,
    half: 14,
    height: 9,
    geometry: () => new THREE.BoxGeometry(0.012, 0.35, 0.012),
    material: () => new THREE.MeshBasicMaterial({ color: "#cfe3ff", transparent: true, opacity: 0.55, fog: true }),
    place: (_i, t, b, r, o) => {
      o.position.set(b.x + 0.08 * t, 9 - wrap(b.y + t * (9 + 3 * r), 9), b.z);
      o.rotation.set(0, 0, 0.05);
      o.scale.setScalar(1);
    },
  },
  leaves: {
    count: 320,
    half: 11,
    height: 7,
    geometry: () => new THREE.PlaneGeometry(0.2, 0.13),
    material: () => new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, fog: true }),
    colors: ["#e07a2f", "#c9432b", "#e8b33d", "#b5541f"],
    place: (i, t, b, r, o) => {
      const fall = 0.35 + 0.3 * r;
      o.position.set(b.x + Math.sin(t * 0.8 + i) * 0.8, 7 - wrap(b.y + t * fall, 7), b.z + Math.cos(t * 0.6 + i * 1.3) * 0.6);
      o.rotation.set(t * (1.5 + r) + i, t * (0.8 + r) + i * 2, t * 1.2);
      o.scale.setScalar(0.8 + 0.6 * r);
    },
  },
  petals: {
    count: 140,
    half: 12,
    height: 6,
    geometry: () => new THREE.PlaneGeometry(0.06, 0.05),
    material: () => new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, fog: true }),
    colors: ["#ffc2d6", "#ffe3ec", "#ffd1a8"],
    place: (i, t, b, r, o) => {
      o.position.set(b.x + Math.sin(t * 0.9 + i) * 1.1 + t * 0.15, 6 - wrap(b.y + t * (0.25 + 0.2 * r), 6), b.z + Math.cos(t * 0.7 + i) * 0.7);
      o.rotation.set(t * 2 + i, t * 1.4 + i, 0);
      o.scale.setScalar(0.8 + 0.5 * r);
    },
  },
  butterflies: {
    count: 18,
    half: 6,
    height: 1.4,
    // Hai cánh hình thoi dựng đứng; vỗ cánh = co giãn theo chiều ngang.
    geometry: () => {
      const g = new THREE.BufferGeometry();
      const v = [0, 0, 0, 0.13, 0.09, 0, 0.12, -0.07, 0, 0, 0, 0, -0.12, -0.07, 0, -0.13, 0.09, 0];
      g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      g.computeVertexNormals();
      return g;
    },
    material: () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: true }),
    colors: ["#ffcc33", "#ff7aa8", "#6ec3f0", "#ffffff", "#ff9f43"],
    farSide: true,
    place: (i, t, b, r, o) => {
      const s = t * (0.3 + 0.25 * r) + i * 1.9;
      o.position.set(b.x + Math.sin(s) * 1.8, 0.7 + b.y + Math.sin(t * 2.6 + i) * 0.22, b.z + Math.sin(s * 1.6 + 1) * 1.3);
      o.rotation.set(0.3 * Math.sin(t * 3 + i), Math.atan2(Math.cos(s) * 1.8, Math.cos(s * 1.6 + 1) * 2.1), 0);
      o.scale.set(0.15 + 0.85 * Math.abs(Math.sin(t * 14 + i * 3)), 1, 1);
    },
  },
  fireflies: {
    count: 70,
    half: 9,
    height: 2.2,
    geometry: () => new THREE.SphereGeometry(0.03, 6, 4),
    material: () => new THREE.MeshBasicMaterial({ color: "#fff2a0", fog: false }),
    place: (i, t, b, r, o) => {
      o.position.set(b.x + Math.sin(t * 0.3 + i) * 0.8, 0.3 + b.y + Math.sin(t * 0.7 + i * 2) * 0.3, b.z + Math.cos(t * 0.25 + i) * 0.8);
      o.scale.setScalar(0.4 + 0.9 * Math.max(0, Math.sin(t * (1.5 + r) + i * 5)));
    },
  },
};

export class ParticleSystems {
  readonly group = new THREE.Group();
  private systems: { spec: Spec; mesh: THREE.InstancedMesh; bases: THREE.Vector3[]; seeds: number[] }[] = [];
  private readonly tmp = new THREE.Object3D();

  /** `away`: hướng (XZ, đơn vị) từ camera mặc định tới tâm – nửa khối "xa" nằm theo hướng này. */
  configure(effects: readonly WeatherEffect[], center: Vec3, away: { x: number; z: number } = { x: 0, z: 1 }): void {
    this.clear();
    effects.forEach((kind, k) => {
      const spec = SPECS[kind];
      const mesh = new THREE.InstancedMesh(spec.geometry(), spec.material(), spec.count);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const bases: THREE.Vector3[] = [];
      const seeds: number[] = [];
      for (let i = 0; i < spec.count; i++) {
        const a = rand(i, k + 1);
        const b = rand(i, k + 7);
        const c = rand(i, k + 13);
        const along = spec.farSide ? (b * 1.1 - 0.1) * spec.half : (b * 2 - 1) * spec.half;
        const side = (a * 2 - 1) * spec.half;
        bases.push(new THREE.Vector3(center.x + away.x * along + away.z * side, c * spec.height, center.z + away.z * along - away.x * side));
        seeds.push(rand(i, k + 29));
        if (spec.colors) mesh.setColorAt(i, new THREE.Color(spec.colors[i % spec.colors.length]!));
      }
      this.group.add(mesh);
      this.systems.push({ spec, mesh, bases, seeds });
    });
  }

  update(t: number): void {
    for (const { spec, mesh, bases, seeds } of this.systems) {
      for (let i = 0; i < bases.length; i++) {
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.setScalar(1);
        spec.place(i, t, bases[i]!, seeds[i]!, this.tmp);
        this.tmp.updateMatrix();
        mesh.setMatrixAt(i, this.tmp.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear(): void {
    for (const s of this.systems) {
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      s.mesh.dispose();
    }
    this.systems = [];
    this.group.clear();
  }
}

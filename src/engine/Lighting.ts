import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { CameraShot, LightingPreset, SceneScript, Vec3 } from "../schemas/scene.schema";
import { DEG } from "./math";

/**
 * Ánh sáng 3 điểm + hậu kỳ, tất định theo (scene, camera tại t):
 *   sun  – nắng đổ bóng; hướng cố định cả cảnh, chọn theo camera chính → nhân vật được chiếu từ phía trước
 *   fill – đèn phụ đi theo camera, không đổ bóng → mặt không bị tối ở góc quay ngược nắng
 *   rim  – đèn viền từ sau lưng nhân vật (so với camera) → tách nhân vật khỏi nền
 *   hemi – ánh sáng trời / mặt đất
 * Hậu kỳ: GTAO (bóng tiếp xúc) + tone mapping + chỉnh màu nhẹ (bão hòa, tương phản, vignette).
 */

interface PresetDef {
  sun: [color: string, intensity: number];
  /** Độ cao mặt trời (độ). */
  elevation: number;
  sky: string;
  ground: string;
  hemi: number;
  fill: [string, number];
  rim: [string, number];
  exposure: number;
  saturation: number;
  contrast: number;
  vignette: number;
}

export const LIGHTING: Record<LightingPreset, PresetDef> = {
  day: { sun: ["#fff4e3", 2.3], elevation: 52, sky: "#e3f0ff", ground: "#6d8a4a", hemi: 1.15, fill: ["#ffffff", 0.75], rim: ["#fff1d0", 0.9], exposure: 1, saturation: 1.08, contrast: 1.04, vignette: 0.18 },
  morning: { sun: ["#ffe0b3", 2.1], elevation: 28, sky: "#dce8ff", ground: "#6a7a4c", hemi: 1.0, fill: ["#fff6ea", 0.7], rim: ["#ffd79a", 1.1], exposure: 1, saturation: 1.06, contrast: 1.05, vignette: 0.2 },
  sunset: { sun: ["#ffab66", 2.0], elevation: 13, sky: "#ffd2b3", ground: "#5b4a3c", hemi: 0.85, fill: ["#ffe2cc", 0.65], rim: ["#ff9147", 1.5], exposure: 1.02, saturation: 1.12, contrast: 1.06, vignette: 0.28 },
  overcast: { sun: ["#ffffff", 1.0], elevation: 62, sky: "#dfe6ee", ground: "#7a8570", hemi: 1.8, fill: ["#ffffff", 0.8], rim: ["#ffffff", 0.35], exposure: 1.02, saturation: 0.96, contrast: 1.02, vignette: 0.15 },
  night: { sun: ["#a9c0ff", 0.9], elevation: 40, sky: "#3a4f86", ground: "#2a3d2a", hemi: 1.05, fill: ["#d0dcff", 1.05], rim: ["#9cbcff", 1.1], exposure: 1.15, saturation: 0.9, contrast: 1.05, vignette: 0.35 },
  snow: { sun: ["#f3f7ff", 1.7], elevation: 34, sky: "#eaf2ff", ground: "#c8d5e6", hemi: 1.55, fill: ["#eef4ff", 0.7], rim: ["#ffffff", 0.6], exposure: 0.98, saturation: 1.0, contrast: 1.03, vignette: 0.16 },
};

/** Góc phương vị (độ) của camera nhìn từ điểm nhìn, trên mặt phẳng XZ. */
function shotAzimuth(shot: CameraShot): number {
  const v = shot.mode === "fixed" ? { x: shot.position.x - shot.lookAt.x, z: shot.position.z - shot.lookAt.z } : { x: shot.offset.x, z: shot.offset.z };
  return Math.atan2(v.x, v.z) / DEG;
}

const GradeShader = {
  name: "GradeShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    saturation: { value: 1 },
    contrast: { value: 1 },
    vignette: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 rgb = mix(vec3(l), c.rgb, saturation);
      rgb = (rgb - 0.5) * contrast + 0.5;
      vec2 d = vUv - 0.5;
      rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, length(d) * 1.4);
      gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
    }`,
};

export class LightRig {
  readonly sun = new THREE.DirectionalLight("#ffffff", 2.4);
  private readonly fill = new THREE.DirectionalLight("#ffffff", 0.7);
  private readonly rim = new THREE.DirectionalLight("#ffffff", 0.9);
  private readonly hemi = new THREE.HemisphereLight("#e6f2ff", "#6d8a4a", 1.2);
  private preset: PresetDef = LIGHTING.day;
  /** Hướng tới mặt trời (đơn vị), cố định trong cảnh. */
  private sunDir = new THREE.Vector3(0.5, 0.8, -0.3).normalize();

  constructor(scene: THREE.Scene) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    const cam = this.sun.shadow.camera;
    cam.left = -18;
    cam.right = 18;
    cam.top = 18;
    cam.bottom = -18;
    cam.near = 1;
    cam.far = 80;
    scene.add(this.hemi, this.sun, this.sun.target, this.fill, this.fill.target, this.rim, this.rim.target);
  }

  configure(script: SceneScript, renderer: THREE.WebGLRenderer): void {
    const l = script.environment.lighting;
    const p = (this.preset = LIGHTING[l.preset]);
    this.sun.color.set(p.sun[0]);
    this.sun.intensity = p.sun[1];
    this.fill.color.set(p.fill[0]);
    this.fill.intensity = p.fill[1];
    this.rim.color.set(p.rim[0]);
    this.rim.intensity = p.rim[1];
    this.hemi.color.set(p.sky);
    this.hemi.groundColor.set(p.ground);
    this.hemi.intensity = p.hemi;
    renderer.toneMappingExposure = p.exposure;
    // Nắng lệch 35° so với hướng camera chính → có khối, bóng đổ ra sau nhân vật.
    const az = (l.sunAzimuth ?? shotAzimuth(script.camera) + 35) * DEG;
    const el = p.elevation * DEG;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  }

  /** Cập nhật theo camera tại thời điểm t (vùng bóng bám điểm nhìn, fill/rim theo hướng camera). */
  update(cam: { position: Vec3; lookAt: Vec3 }): void {
    const at = new THREE.Vector3(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    const shadowCenter = new THREE.Vector3(at.x, 0, at.z);
    this.sun.target.position.copy(shadowCenter);
    this.sun.position.copy(shadowCenter).addScaledVector(this.sunDir, 25);

    const view = new THREE.Vector3(cam.position.x - at.x, 0, cam.position.z - at.z);
    if (view.lengthSq() < 1e-6) view.set(0, 0, 1);
    view.normalize();
    this.fill.target.position.copy(at);
    this.fill.position.set(cam.position.x, cam.position.y + 1.5, cam.position.z);
    this.rim.target.position.copy(at);
    this.rim.position.copy(at).addScaledVector(view, -8).add(new THREE.Vector3(0, 6, 0));
  }

  get grade(): { saturation: number; contrast: number; vignette: number } {
    return this.preset;
  }
}

/** EffectComposer: render (MSAA) → GTAO → tone mapping/sRGB → chỉnh màu. */
export class PostFx {
  readonly composer: EffectComposer;
  private readonly ao: GTAOPass;
  private readonly grade: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, width, height);
    this.ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  configure(enabledAo: boolean, grade: { saturation: number; contrast: number; vignette: number }): void {
    this.ao.enabled = enabledAo;
    this.grade.uniforms.saturation!.value = grade.saturation;
    this.grade.uniforms.contrast!.value = grade.contrast;
    this.grade.uniforms.vignette!.value = grade.vignette;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}

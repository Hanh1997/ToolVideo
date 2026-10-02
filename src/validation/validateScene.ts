import { COMMERCIAL_LICENSES, findAsset, resolveClip, type AssetType, type Registry } from "../schemas/asset.schema";
import {
  SceneScriptSchema,
  isMotionAction,
  isPropAction,
  type Action,
  type CameraShot,
  type SceneScript,
} from "../schemas/scene.schema";

export type SceneErrorCode =
  | "InvalidSchema"
  | "DuplicateId"
  | "AssetNotFound"
  | "AssetTypeMismatch"
  | "TargetNotFound"
  | "AnimationNotFound"
  | "ActionOutOfRange"
  | "ActionOverlap"
  | "AudioOutOfRange"
  | "DialogueOutOfRange"
  | "DialogueOverlap"
  | "LicenseViolation";

export interface SceneIssue {
  code: SceneErrorCode;
  message: string;
  path?: string;
}

export type ValidationResult =
  | { ok: true; scene: SceneScript }
  | { ok: false; issues: SceneIssue[] };

const EPS = 1e-6;

export function validateScene(input: unknown, registry: Registry): ValidationResult {
  const parsed = SceneScriptSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "InvalidSchema",
        message: i.message,
        path: i.path.map(String).join("."),
      })),
    };
  }

  const scene = parsed.data;
  const issues: SceneIssue[] = [];

  checkDuplicates(scene, issues);
  checkAssets(scene, registry, issues);
  checkActions(scene, registry, issues);
  checkAudio(scene, registry, issues);
  checkDialogue(scene, issues);
  checkLicense(scene, registry, issues);

  return issues.length === 0 ? { ok: true, scene } : { ok: false, issues };
}

function checkDuplicates(scene: SceneScript, issues: SceneIssue[]): void {
  const groups: [string, { id: string }[]][] = [
    ["characters/props", [...scene.characters, ...scene.props]],
    ["actions", scene.actions],
    ["audio", scene.audio],
    ["dialogue", scene.dialogue],
  ];
  for (const [group, items] of groups) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        issues.push({ code: "DuplicateId", message: `id "${item.id}" bị trùng trong ${group}`, path: group });
      }
      seen.add(item.id);
    }
  }
}

function checkAssetRef(
  registry: Registry,
  assetId: string,
  expected: AssetType,
  path: string,
  issues: SceneIssue[],
): void {
  const asset = findAsset(registry, assetId);
  if (!asset) {
    issues.push({ code: "AssetNotFound", message: `Asset "${assetId}" không có trong Registry`, path });
  } else if (asset.type !== expected) {
    issues.push({
      code: "AssetTypeMismatch",
      message: `Asset "${assetId}" là ${asset.type}, cần ${expected}`,
      path,
    });
  }
}

function checkAssets(scene: SceneScript, registry: Registry, issues: SceneIssue[]): void {
  checkAssetRef(registry, scene.environment.asset, "environment", "environment.asset", issues);
  scene.characters.forEach((c, i) => checkAssetRef(registry, c.asset, "character", `characters.${i}.asset`, issues));
  scene.props.forEach((p, i) => checkAssetRef(registry, p.asset, "prop", `props.${i}.asset`, issues));
  scene.audio.forEach((a, i) => checkAssetRef(registry, a.asset, "audio", `audio.${i}.asset`, issues));
  scene.characters.forEach((c, i) => {
    if (c.voice) checkAssetRef(registry, c.voice, "voice", `characters.${i}.voice`, issues);
  });
  scene.dialogue.forEach((l, i) => checkAssetRef(registry, l.voice, "voice", `dialogue.${i}.voice`, issues));
}

function checkDialogue(scene: SceneScript, issues: SceneIssue[]): void {
  const characters = new Set(scene.characters.map((c) => c.id));
  scene.dialogue.forEach((line, i) => {
    const path = `dialogue.${i}`;
    if (line.speaker && !characters.has(line.speaker)) {
      issues.push({ code: "TargetNotFound", message: `Câu thoại "${line.id}" của nhân vật "${line.speaker}" không tồn tại`, path: `${path}.speaker` });
    }
    if (line.to && !characters.has(line.to)) {
      issues.push({ code: "TargetNotFound", message: `Câu thoại "${line.id}" nói với nhân vật "${line.to}" không tồn tại`, path: `${path}.to` });
    }
    if (line.start + line.duration > scene.meta.duration + EPS) {
      issues.push({
        code: "DialogueOutOfRange",
        message: `Câu thoại "${line.id}" kết thúc ở ${(line.start + line.duration).toFixed(2)}s, vượt thời lượng ${scene.meta.duration}s (gợi ý: meta.duration = "auto")`,
        path,
      });
    }
  });
  const bySpeaker = new Map<string, SceneScript["dialogue"]>();
  for (const line of scene.dialogue) {
    const key = line.speaker ?? "__narrator__";
    bySpeaker.set(key, [...(bySpeaker.get(key) ?? []), line]);
  }
  for (const [speaker, lines] of bySpeaker) {
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.start < prev.start + prev.duration - EPS) {
        issues.push({
          code: "DialogueOverlap",
          message: `Câu "${prev.id}" và "${cur.id}" của ${speaker === "__narrator__" ? "người dẫn chuyện" : speaker} nói chồng lên nhau`,
          path: "dialogue",
        });
      }
    }
  }
}

function checkAudio(scene: SceneScript, registry: Registry, issues: SceneIssue[]): void {
  scene.audio.forEach((track, i) => {
    const path = `audio.${i}`;
    if (track.start >= scene.meta.duration) {
      issues.push({
        code: "AudioOutOfRange",
        message: `Audio "${track.id}" bắt đầu ở ${track.start}s, sau khi video kết thúc (${scene.meta.duration}s)`,
        path: `${path}.start`,
      });
    }
    const asset = findAsset(registry, track.asset);
    if (asset?.type === "audio" && asset.duration !== undefined && !track.loop && track.trimStart >= asset.duration) {
      issues.push({
        code: "AudioOutOfRange",
        message: `Audio "${track.id}": trimStart ${track.trimStart}s vượt độ dài file ${asset.duration}s`,
        path: `${path}.trimStart`,
      });
    }
  });
}

function checkShotTarget(scene: SceneScript, shot: CameraShot, path: string, issues: SceneIssue[]): void {
  if (shot.mode === "follow" && !scene.characters.some((c) => c.id === shot.target)) {
    issues.push({ code: "TargetNotFound", message: `Camera follow nhân vật "${shot.target}" không tồn tại`, path });
  }
}

type OverlapGroup = "motion" | "animation" | "jump" | "pose" | "camera";

/** Sự kiện đồ vật là tức thời → không kiểm tra chồng thời gian. */
function overlapGroup(action: Action): OverlapGroup | undefined {
  if (isMotionAction(action)) return "motion";
  if (isPropAction(action)) return undefined;
  return action.type;
}

function checkActions(scene: SceneScript, registry: Registry, issues: SceneIssue[]): void {
  const characters = new Map(scene.characters.map((c) => [c.id, c]));
  const props = new Set(scene.props.map((p) => p.id));
  checkShotTarget(scene, scene.camera, "camera", issues);

  const buckets = new Map<string, Action[]>();

  scene.actions.forEach((action, i) => {
    const path = `actions.${i}`;
    if (action.start + action.duration > scene.meta.duration + EPS) {
      issues.push({
        code: "ActionOutOfRange",
        message: `Action "${action.id}" kết thúc ở ${(action.start + action.duration).toFixed(3)}s, vượt quá thời lượng ${scene.meta.duration}s`,
        path,
      });
    }

    let owner = "__camera__";
    if (action.type === "camera") {
      checkShotTarget(scene, action.shot, `${path}.shot`, issues);
    } else if (isPropAction(action)) {
      if (!props.has(action.target)) {
        issues.push({ code: "TargetNotFound", message: `Action "${action.id}" trỏ tới đồ vật "${action.target}" không có trong props`, path: `${path}.target` });
      }
      if (action.type === "attach" && !characters.has(action.to)) {
        issues.push({ code: "TargetNotFound", message: `Action "${action.id}" gắn đồ vật vào nhân vật "${action.to}" không tồn tại`, path: `${path}.to` });
      }
      return;
    } else {
      const character = characters.get(action.target);
      if (!character) {
        issues.push({ code: "TargetNotFound", message: `Action "${action.id}" trỏ tới nhân vật "${action.target}" không tồn tại`, path });
        return;
      }
      owner = action.target;
      if (action.type === "animation") {
        const asset = findAsset(registry, character.asset);
        if (asset && asset.type === "character" && !resolveClip(asset, action.clip)) {
          issues.push({
            code: "AnimationNotFound",
            message: `Animation "${action.clip}" không tồn tại trong ${asset.id}. Có: ${[...Object.keys(asset.clipAliases), ...asset.clips].join(", ")}`,
            path: `${path}.clip`,
          });
        }
      }
    }

    const group = overlapGroup(action);
    if (!group) return;
    const key = `${owner}|${group}`;
    const list = buckets.get(key) ?? [];
    list.push(action);
    buckets.set(key, list);
  });

  for (const [key, list] of buckets) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.start < prev.start + prev.duration - EPS) {
        const [owner, group] = key.split("|");
        issues.push({
          code: "ActionOverlap",
          message: `Action "${prev.id}" và "${cur.id}" (${group}${owner === "__camera__" ? "" : ` của ${owner}`}) chồng thời gian`,
          path: "actions",
        });
      }
    }
  }
}

function sceneAssetIds(scene: SceneScript): Set<string> {
  return new Set([
    scene.environment.asset,
    ...scene.characters.map((c) => c.asset),
    ...scene.props.map((p) => p.asset),
    ...scene.audio.map((a) => a.asset),
    ...scene.characters.flatMap((c) => (c.voice ? [c.voice] : [])),
    ...scene.dialogue.map((l) => l.voice),
  ]);
}

function checkLicense(scene: SceneScript, registry: Registry, issues: SceneIssue[]): void {
  const ids = sceneAssetIds(scene);
  for (const assetId of ids) {
    const asset = findAsset(registry, assetId);
    if (!asset) continue;
    if (asset.commercialUse && !COMMERCIAL_LICENSES.has(asset.license)) {
      issues.push({
        code: "LicenseViolation",
        message: `Asset "${asset.id}" đánh dấu commercialUse nhưng license "${asset.license}" không cho phép`,
      });
    }
    if (scene.meta.commercial && !asset.commercialUse) {
      issues.push({
        code: "LicenseViolation",
        message: `Project thương mại nhưng asset "${asset.id}" không cho phép dùng thương mại`,
      });
    }
  }
}

/** Danh sách ghi công cho các asset trong scene (dùng cho ATTRIBUTIONS.txt). */
export function collectAttributions(scene: SceneScript, registry: Registry): string[] {
  const ids = sceneAssetIds(scene);
  const lines: string[] = [];
  for (const assetId of ids) {
    const a = findAsset(registry, assetId);
    if (a) lines.push(`${a.name} – ${a.author} – ${a.license} – ${a.source}`);
  }
  return lines;
}

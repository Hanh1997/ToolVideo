import { findAsset, type Registry } from "../schemas/asset.schema";

/**
 * Đồ vật AI được dùng trong kịch bản (nhặt / cầm / trao / đặt xuống).
 * Chọn món nhỏ, cầm được; kích thước khi đặt trên đất (`groundScale`) và khi cầm (asset.holdHeight trong Registry).
 * `cluster`: đặt thêm vài món cùng loại quanh món được nhặt (bụi hoa, cụm nấm…) – nhặt một, phần còn lại ở lại.
 */
export interface ObjectKind {
  asset: string;
  /** Mô tả tiếng Anh gửi cho AI. */
  label: string;
  groundScale: number;
  cluster?: string[];
  /** Tiền tố id âm thanh khi nhặt (chọn biến thể tất định). Mặc định: tiếng vải sột soạt. */
  pickupSound?: string;
}

export const OBJECT_KINDS: Record<string, ObjectKind> = {
  flower_red: { asset: "prop_kn_flower_red_a", label: "a red flower (picked from a flower patch)", groundScale: 0.6, cluster: ["prop_kn_flower_yellow_a", "prop_kn_flower_purple_a", "prop_kn_flower_red_b"], pickupSound: "sfx_pluck_" },
  flower_yellow: { asset: "prop_kn_flower_yellow_a", label: "a yellow flower (picked from a flower patch)", groundScale: 0.6, cluster: ["prop_kn_flower_red_a", "prop_kn_flower_purple_a", "prop_kn_flower_yellow_b"], pickupSound: "sfx_pluck_" },
  flower_purple: { asset: "prop_kn_flower_purple_a", label: "a purple flower (picked from a flower patch)", groundScale: 0.6, cluster: ["prop_kn_flower_red_a", "prop_kn_flower_yellow_a", "prop_kn_flower_purple_b"], pickupSound: "sfx_pluck_" },
  mushroom: { asset: "prop_kn_mushroom_red", label: "a red mushroom (picked from a group of mushrooms)", groundScale: 0.45, cluster: ["prop_kn_mushroom_tan", "prop_kn_mushroom_red_tall"], pickupSound: "sfx_pluck_" },
  carrot: { asset: "prop_kn_crop_carrot", label: "a carrot (pulled from the ground)", groundScale: 0.25, pickupSound: "sfx_pluck_" },
  pumpkin: { asset: "prop_kn_crop_pumpkin", label: "a small pumpkin", groundScale: 0.25 },
  fish: { asset: "prop_pz_fish", label: "a fish", groundScale: 1 },
  stone: { asset: "prop_kn_rock_small_a", label: "a small stone", groundScale: 0.3 },
  stick: { asset: "prop_n_wood_log", label: "a wooden stick / small log", groundScale: 0.45 },
  flower_pot: { asset: "prop_gd_flower_pot", label: "a potted plant (a nice gift)", groundScale: 0.35 },
  cup: { asset: "prop_gd_cup", label: "a cup", groundScale: 1 },
  water_bottle: { asset: "prop_gd_bottle", label: "a bottle of water", groundScale: 0.8 },
  trash_bottle: { asset: "prop_trash_bottle", label: "a plastic bottle thrown on the ground (litter)", groundScale: 1 },
  trash_can: { asset: "prop_trash_can", label: "an empty can thrown on the ground (litter)", groundScale: 1 },
  trash_bag: { asset: "prop_trash_bag", label: "a trash bag left on the ground (litter)", groundScale: 1 },
};

/** Loại đồ vật có asset trong Registry. */
export function availableObjectKinds(registry: Registry): string[] {
  return Object.entries(OBJECT_KINDS)
    .filter(([, k]) => findAsset(registry, k.asset)?.type === "prop")
    .map(([id]) => id);
}

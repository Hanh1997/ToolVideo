import { useEffect, useState } from "react";
import type { AssetEntry } from "../schemas/asset.schema";
import { assetThumbnail } from "./modelPreview";

/** Ảnh thu nhỏ 3D, chỉ render khi thẻ hiện trên màn hình. */
export function AssetThumb({ asset }: { asset: AssetEntry }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      assetThumbnail(asset).then(
        (u) => !cancelled && setUrl(u),
        () => !cancelled && setFailed(true),
      );
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [el, asset]);

  return (
    <div className="asset-thumb" ref={setEl}>
      {url ? <img src={url} alt="" /> : <span className="muted small">{failed ? "Lỗi tải model" : "…"}</span>}
    </div>
  );
}

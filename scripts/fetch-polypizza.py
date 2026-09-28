"""
Tải một bundle trên Poly Pizza (poly.pizza) – nơi host lại từng mẫu của Quaternius, Kenney, v.v.

  .venv/Scripts/python scripts/fetch-polypizza.py <url bundle> <thư mục đích> [--list]

Mỗi mẫu tải về <đích>/GLB/<Tên>.glb; <đích>/manifest.json ghi tên, tác giả, giấy phép, link từng mẫu
(dùng khi nhập asset và ghi ATTRIBUTIONS – bundle có thể trộn CC0 với CC-BY).
--list: chỉ in danh sách, không tải. Bỏ qua file đã có; thử lại 3 lần; FETCH_WORKERS (mặc định 4).
"""
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"}
CARD = re.compile(
    r'static\.poly\.pizza/([0-9a-f-]{36})\.webp"[^>]*alt="([^"]*)"'  # uuid + tên
    r'.*?to="/m/([A-Za-z0-9]+)"'  # id trang mẫu
    r'.*?href="/u/([^"]+)"'  # tác giả
    r'.*?>(CC0|CC-BY[^<]*|Public Domain[^<]*)<',  # giấy phép
    re.S,
)


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_") or "model"


def parse(url: str) -> list[dict]:
    html = requests.get(url, headers=UA, timeout=60).text
    models, seen = [], {}
    for uuid, title, mid, author, lic in CARD.findall(html):
        if uuid in {m["uuid"] for m in models}:
            continue
        base = safe(title)
        seen[base] = seen.get(base, 0) + 1
        file = base if seen[base] == 1 else f"{base}_{seen[base]}"
        models.append({
            "file": f"GLB/{file}.glb", "title": title, "uuid": uuid, "author": author,
            "license": "CC0-1.0" if lic.startswith(("CC0", "Public")) else "CC-BY-3.0",  # Poly Pizza: CC-BY = CC BY 3.0
            "page": f"https://poly.pizza/m/{mid}",
        })
    return models


def fetch(uuid: str, dest: str) -> int:
    for attempt in range(3):
        try:
            with requests.get(f"https://static.poly.pizza/{uuid}.glb", headers=UA, stream=True, timeout=120) as r:
                r.raise_for_status()
                tmp = dest + ".part"
                size = 0
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(1 << 16):
                        fh.write(chunk)
                        size += len(chunk)
                os.replace(tmp, dest)
                return size
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise
            print(f"  thử lại ({e})")
            time.sleep(2 + attempt * 3)
    return 0


def main() -> None:
    url, out, *flags = sys.argv[1:]
    models = parse(url)
    authors = sorted({m["author"] for m in models})
    licenses = sorted({m["license"] for m in models})
    print(f"{len(models)} mẫu – tác giả: {', '.join(authors)} – giấy phép: {', '.join(licenses)}")
    if "--list" in flags:
        for m in models:
            print(f"  {m['file']}  [{m['license']}, {m['author']}]")
        return
    os.makedirs(os.path.join(out, "GLB"), exist_ok=True)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"source": url, "models": models}, fh, ensure_ascii=False, indent=2)
    todo = [m for m in models if not (os.path.exists(p := os.path.join(out, m["file"])) and os.path.getsize(p) > 0)]

    def job(m):
        try:
            return fetch(m["uuid"], os.path.join(out, m["file"])), None
        except Exception as e:  # noqa: BLE001
            return 0, f"{m['file']}: {e}"

    total = failed = 0
    with ThreadPoolExecutor(max_workers=int(os.environ.get("FETCH_WORKERS", "4"))) as pool:
        for size, err in pool.map(job, todo):
            total += size
            if err:
                failed += 1
                print(f"  ✗ {err}")
    print(f"xong: {total / 1024 / 1024:.1f} MB mới, {failed} lỗi")


if __name__ == "__main__":
    main()

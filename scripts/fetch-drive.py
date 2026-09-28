"""
Tải có chọn lọc một thư mục Google Drive công khai (vd. các gói CC0 của Quaternius).

  .venv/Scripts/python scripts/fetch-drive.py <url thư mục> <thư mục đích> <tiền tố>...

Tiền tố lọc theo đường dẫn trong thư mục Drive, vd. "glTF/" "FBX/" hoặc "*" (file ở gốc: License, Preview).
Liệt kê bằng gdown; tải song song (FETCH_WORKERS, mặc định 6) qua endpoint drive.usercontent. Bỏ qua file đã có; thử lại 3 lần.
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import gdown
import requests

URL = "https://drive.usercontent.google.com/download"


def wanted(path: str, prefixes: list[str]) -> bool:
    for p in prefixes:
        if p == "*" and "/" not in path:
            return True
        if p != "*" and path.startswith(p):
            return True
    return False


def fetch(file_id: str, dest: str) -> int:
    for attempt in range(3):
        try:
            with requests.get(URL, params={"id": file_id, "export": "download", "confirm": "t"}, stream=True, timeout=120) as r:
                r.raise_for_status()
                if "text/html" in r.headers.get("content-type", ""):
                    raise RuntimeError("Drive trả về trang HTML (giới hạn tải?)")
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
    url, out, *prefixes = sys.argv[1:]
    files = gdown.download_folder(url, skip_download=True, quiet=True)
    picked = [f for f in files if wanted(f.path.replace("\\", "/"), prefixes)]
    print(f"{len(picked)}/{len(files)} file → {out}")
    todo = []
    for f in picked:
        rel = f.path.replace("\\", "/")
        dest = os.path.join(out, *rel.split("/"))
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        todo.append((f.id, rel, dest))

    def job(item):
        fid, rel, dest = item
        try:
            return fetch(fid, dest), None
        except Exception as e:  # noqa: BLE001
            return 0, f"{rel}: {e}"

    # Song song: mỗi file nhỏ tốn chủ yếu thời gian chờ request.
    total = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=int(os.environ.get("FETCH_WORKERS", "6"))) as pool:
        for size, err in pool.map(job, todo):
            total += size
            if err:
                failed += 1
                print(f"  ✗ {err}")
    print(f"xong: {total / 1024 / 1024:.1f} MB mới, {failed} lỗi")


if __name__ == "__main__":
    main()

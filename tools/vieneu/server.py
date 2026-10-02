"""Tiến trình đọc giọng VieNeu-TTS chạy nền cho AutoCartoon (nạp model một lần, nhận nhiều câu).

Giao thức: mỗi dòng stdin là một JSON {"id", "text", "voice", "out", "seed"} → ghi WAV 48 kHz vào `out`,
trả về một dòng stdout "@@" + JSON {"id", "ok": true} hoặc {"id", "ok": false, "error"}.
Log của thư viện đi ra stderr / dòng không có "@@" (phía Node bỏ qua).
"""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")


def reply(obj):
    sys.stdout.write("@@" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    import numpy as np
    import vieneu_patch

    tts = vieneu_patch.load()
    reply({"id": "ready", "ok": True})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req = {}
        try:
            req = json.loads(raw)
            # Tất định theo seed (lấy mẫu có ngẫu nhiên); kết quả còn được cache theo nội dung phía Node.
            seed = int(req.get("seed", 0)) % (2**32)
            random.seed(seed)
            np.random.seed(seed)
            audio = tts.infer(req["text"], voice=req["voice"])
            tts.save(audio, req["out"])
            reply({"id": req.get("id"), "ok": True})
        except Exception as e:  # noqa: BLE001 – báo lỗi từng câu, tiến trình vẫn chạy
            reply({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()

"""Nạp VieNeu-TTS (v3 Turbo, ONNX/CPU) với model tải về thư mục riêng dạng file thật.

ONNX Runtime ≥ 1.2x từ chối đọc trọng số ngoài (*.data) qua cache HuggingFace trên Windows
(file .onnx và .data nằm ở hai thư mục blob khác nhau). Thay _fetch → hf_hub_download(local_dir=…).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "tools" / "tts-voices" / "vieneu"


def load(threads: int = 0):
    from huggingface_hub import hf_hub_download
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine import onnx_runtime_lite as lite

    def _fetch(repo, files, subfolder):
        last = None
        for fn in files:
            try:
                last = hf_hub_download(repo, fn, repo_type="model", subfolder=subfolder or None, local_dir=str(ROOT / repo.replace("/", "__")))
            except Exception:
                if fn.endswith(".json"):
                    continue
                raise
        return Path(last).parent

    lite.OnnxV3LiteEngine._fetch = staticmethod(_fetch)
    return Vieneu(threads=threads)

import subprocess
import sys
import os
import json
import warnings

warnings.filterwarnings("ignore")

from funasr import AutoModel

# 抖音视频 → 文字。
#
# 为什么需要它：抖音网页版只给文字（标题/文案/评论），看不到画面也听不到声音。
# 但「理解内容」最直接的信息其实在视频里说了什么。所以这里做两步：
#   1. ffmpeg 从视频里抽出音轨（16k 单声道，FunASR 要求的格式）
#   2. FunASR（Paraformer + VAD + 标点）转成带标点的中文
#
# 这套模型是 GPT-SoVITS 自带的，不用额外下载，纯本地 CPU 跑。

G = r"D:\Users\未开封的汽水\Documents\Downloads\新建文件夹\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
FFMPEG = r"D:\Users\未开封的汽水\Documents\Downloads\新建文件夹\RVC\RVC20260718Nvidia50x0\ffmpeg.exe"

MODEL_DIR = os.path.join(G, "tools", "asr", "models", "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
VAD_DIR = os.path.join(G, "tools", "asr", "models", "speech_fsmn_vad_zh-cn-16k-common-pytorch")
PUNC_DIR = os.path.join(G, "tools", "asr", "models", "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")

_model = None


def get_model():
    global _model
    if _model is None:
        kwargs = {
            "model": MODEL_DIR,
            "vad_model": VAD_DIR,
            "vad_kwargs": {"max_single_segment_time": 30000},
            "disable_update": True,
            "device": "cpu",
        }
        # 标点模型存在才加载（它能显著提升可读性）
        if os.path.isdir(PUNC_DIR):
            kwargs["punc_model"] = PUNC_DIR
        _model = AutoModel(**kwargs)
    return _model


def extract_audio(video_path, out_wav):
    """从视频抽 16k 单声道 wav。"""
    os.makedirs(os.path.dirname(out_wav), exist_ok=True)
    cmd = [
        FFMPEG, "-y", "-i", video_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", out_wav,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if not os.path.exists(out_wav):
        raise RuntimeError(f"音频抽取失败: {(r.stderr or '')[-400:]}")
    return out_wav


def transcribe(audio_path, max_seconds=600):
    """
    转写音频。max_seconds 限制处理时长——太长的视频转写很慢，
    而且抖音视频绝大多数在 5 分钟内。
    """
    model = get_model()
    res = model.generate(
        input=audio_path,
        batch_size_s=300,
        # 单段最长 30 秒，避免长静音拖慢
        max_single_segment_time=30000,
    )
    text = "".join(item.get("text", "") for item in res).strip()
    return text


def main():
    if len(sys.argv) < 2:
        print("用法: python douyin_transcribe.py <视频或音频路径> [输出txt]")
        return

    src = sys.argv[1]
    if not os.path.exists(src):
        print(json.dumps({"ok": False, "error": f"文件不存在: {src}"}, ensure_ascii=False))
        return

    base = os.path.splitext(src)[0]
    wav = base + ".asr.wav"

    try:
        # 已经是音频就直接用
        if src.lower().endswith((".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg")):
            wav = src
        else:
            extract_audio(src, wav)

        text = transcribe(wav)
        result = {"ok": True, "text": text, "chars": len(text)}

        if len(sys.argv) > 2:
            with open(sys.argv[2], "w", encoding="utf-8") as f:
                f.write(text)
            result["saved"] = sys.argv[2]

        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()

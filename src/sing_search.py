import os
import sys
"""点歌流程的搜索与下载部分。

用 bilibili-api-python 搜索（比 yt-dlp 拿到的元数据完整），
再用 yt-dlp 下载音频流。

为什么不直接用 yt-dlp 搜 B 站：`bilisearch` 只返回 ID，标题和时长都是 NA，
没法判断哪条是真正的清唱/原曲。
"""

import sys
import json
import os
import subprocess
import asyncio
import traceback

# 路径全部走环境变量或相对定位，不硬编码。
# 调用方（song.mjs）会通过 env 传入；单独跑时用下面的回退。
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)

BILI_VENV = os.environ.get("BILI_PYTHON") or sys.executable

# yt-dlp：优先环境变量，其次 PATH，最后常见安装位置
YTDLP = os.environ.get("YTDLP") or "yt-dlp"
if os.environ.get("YTDLP") is None:
    import shutil
    if not shutil.which("yt-dlp"):
        _common = os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            "Programs", "Python", "Python312", "Scripts", "yt-dlp.exe",
        )
        if os.path.exists(_common):
            YTDLP = _common

# ffmpeg：优先环境变量，其次 RVC 目录下的，再次 PATH
RVC_FFMPEG = os.environ.get("FFMPEG") or ""
if not RVC_FFMPEG:
    _rvc = os.path.join(PROJECT_ROOT, "..", "RVC", "RVC20260718Nvidia50x0", "ffmpeg.exe")
    RVC_FFMPEG = os.path.abspath(_rvc) if os.path.exists(_rvc) else "ffmpeg"

OUT_DIR = os.environ.get("SING_DL_DIR") or os.path.join(PROJECT_ROOT, "state", "sing-dl")


async def search_bili(keyword, limit=10):
    from bilibili_api import search, sync
    # 搜视频
    res = await search.search_by_type(
        keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
    )
    items = []
    for v in (res.get("result") or [])[:limit]:
        # 去掉 html 标签
        import re
        title = re.sub(r"<[^>]+>", "", v.get("title") or "")
        items.append({
            "bvid": v.get("bvid"),
            "title": title,
            "author": v.get("author"),
            "duration": v.get("duration"),   # "3:12" 形式
            "play": v.get("play"),
            "pubdate": v.get("pubdate"),
        })
    return items


def download_audio(bvid, out_dir=OUT_DIR):
    """用 yt-dlp 只下音频，转成 wav。"""
    os.makedirs(out_dir, exist_ok=True)
    url = f"https://www.bilibili.com/video/{bvid}"
    tpl = os.path.join(out_dir, f"{bvid}.%(ext)s")

    cmd = [
        YTDLP,
        "--no-warnings",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "wav",
        "--audio-quality", "0",
        "--ffmpeg-location", RVC_FFMPEG,
        "-o", tpl,
        "--no-playlist",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                       env={**os.environ, "PYTHONUTF8": "1"})

    wav = os.path.join(out_dir, f"{bvid}.wav")
    if os.path.exists(wav):
        return {"ok": True, "path": wav, "size_mb": round(os.path.getsize(wav) / 1024 / 1024, 1)}

    # 有些情况会留下其他扩展名
    for f in os.listdir(out_dir):
        if f.startswith(bvid) and f.endswith((".wav", ".m4a", ".mp3", ".webm")):
            p = os.path.join(out_dir, f)
            return {"ok": True, "path": p, "size_mb": round(os.path.getsize(p) / 1024 / 1024, 1)}

    return {"ok": False, "error": (r.stderr or r.stdout or "")[-500:]}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "search"

    if action == "search":
        kw = sys.argv[2] if len(sys.argv) > 2 else "雨爱"
        try:
            items = asyncio.run(search_bili(kw, 10))
            print(json.dumps({"ok": True, "items": items}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}",
                              "trace": traceback.format_exc()[-800:]}, ensure_ascii=False))

    elif action == "download":
        bvid = sys.argv[2]
        try:
            r = download_audio(bvid)
            print(json.dumps(r, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()

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


def _load_credential():
    """读 bili-duty 的登录凭证。

    2026-10 起 B 站对无凭证请求大量返回 412 风控页，带 sessdata+buvid3 才能稳定拿到流地址。
    凭证缺失不算致命：降级为匿名请求，让上层看到明确错误而不是静默失败。
    """
    from bilibili_api import Credential
    cands = [
        os.environ.get("BILI_CREDENTIAL"),
        os.path.join(os.environ.get("APPDATA", ""), "dsh-desktop", "harness", "bili-duty", "bili_credential.json"),
        os.path.join(PROJECT_ROOT, "state", "bili_credential.json"),
    ]
    for p in cands:
        if not p or not os.path.exists(p):
            continue
        try:
            d = json.load(open(p, encoding="utf-8"))
            cred = Credential(
                sessdata=d.get("sessdata") or None,
                bili_jct=d.get("bili_jct") or None,
                buvid3=d.get("buvid3") or None,
                dedeuserid=d.get("dedeuserid") or None,
            )
            if cred.has_sessdata():
                return cred
        except Exception:
            continue
    return None


def download_audio(bvid, out_dir=OUT_DIR):
    """下载音频并转成 wav。

    走 B 站官方 API 直链，**不再经过 yt-dlp**。
    原因：yt-dlp 2026.10.21（当前最新稳定版）解析 B 站页面时报
    `Unable to extract initial state` —— B 站改了前端结构，上游还没修。
    官方 API 这条路更稳：拿到 dash.audio 直链后自己下 m4s，再 ffmpeg 转 wav。

    取流优先级：dash.audio 最高码率 > dash.flac > durl（老视频没有 dash）。
    """
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, f"{bvid}.wav")

    try:
        import asyncio
        from bilibili_api import video
    except Exception as e:
        return {"ok": False, "error": f"bilibili_api 不可用: {type(e).__name__}: {e}"}

    async def _fetch():
        cred = _load_credential()
        v = video.Video(bvid=bvid, credential=cred) if cred else video.Video(bvid=bvid)
        info = await v.get_info()
        cid = (info.get("pages") or [{}])[0].get("cid") or info.get("cid")
        data = await v.get_download_url(cid=cid)
        return info, data

    try:
        info, data = asyncio.run(_fetch())
    except Exception as e:
        return {"ok": False, "error": f"取流失败 {type(e).__name__}: {str(e)[:300]}"}

    dash = data.get("dash") or {}
    candidates = []
    for a in (dash.get("audio") or []):
        u = a.get("baseUrl") or a.get("base_url") or ""
        if u:
            candidates.append((a.get("bandwidth") or 0, u))
    flac = (dash.get("flac") or {}).get("audio")
    if flac:
        u = flac.get("baseUrl") or flac.get("base_url") or ""
        if u:
            candidates.append((10 ** 9, u))   # flac 优先
    if not candidates:
        for d in (data.get("durl") or []):
            u = d.get("url") or ""
            if u:
                candidates.append((0, u))
    if not candidates:
        return {"ok": False, "error": "API 未返回任何音频流（可能需要登录凭证或视频受限）"}

    candidates.sort(key=lambda x: x[0], reverse=True)
    url = candidates[0][1]

    # 直链需要 Referer，否则 403
    raw = os.path.join(out_dir, f"{bvid}.m4s")
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": f"https://www.bilibili.com/video/{bvid}",
            "Origin": "https://www.bilibili.com",
        })
        with urllib.request.urlopen(req, timeout=180) as resp, open(raw, "wb") as f:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    except Exception as e:
        return {"ok": False, "error": f"下载失败 {type(e).__name__}: {str(e)[:300]}"}

    if not os.path.exists(raw) or os.path.getsize(raw) < 1024:
        return {"ok": False, "error": "下载到的文件为空"}

    # m4s → wav
    ff = RVC_FFMPEG if os.path.exists(RVC_FFMPEG) else "ffmpeg"
    cmd = [ff, "-y", "-loglevel", "error", "-i", raw, "-vn",
           "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", wav_path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if os.path.exists(wav_path) and os.path.getsize(wav_path) > 1024:
        try:
            os.remove(raw)
        except Exception:
            pass
        return {"ok": True, "path": wav_path,
                "size_mb": round(os.path.getsize(wav_path) / 1024 / 1024, 1),
                "title": info.get("title")}

    return {"ok": False, "error": f"ffmpeg 转码失败: {(r.stderr or '')[-300:]}"}



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

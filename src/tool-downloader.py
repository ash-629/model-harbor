#!/usr/bin/env python3
"""Resolve and download the official Windows ChatGPT desktop MSIX.

The Store product API may omit the package version, so this helper queries the
public Windows Update package index used by Microsoft Store downloaders. Only
the fixed ChatGPT product is accepted, and package links must come from the
Microsoft delivery CDN. No credentials or signed download URLs are printed.
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

PRODUCT_ID = "9PLM9XGG6VKS"
INDEX_URL = "https://store.rg-adguard.net/api/GetFiles"
PACKAGE_RE = re.compile(r"^OpenAI\.Codex_([0-9][0-9A-Za-z.-]*)_x64__[^/]+\.(?:msix|msixbundle)$")
CDN_HOSTS = ("delivery.mp.microsoft.com",)


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def fail(message, code=1):
    emit({"type": "error", "message": message})
    raise SystemExit(code)


def opener():
    proxy = (os.environ.get("MH_TOOL_PROXY") or os.environ.get("TOOL_DOWNLOAD_PROXY") or "").strip()
    if proxy and ("\r" in proxy or "\n" in proxy):
        fail("下载代理配置无效")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


def official_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "http" or not any(host == h or host.endswith("." + h) for h in CDN_HOSTS):
        return False
    if parsed.username or parsed.password or not parsed.path.startswith("/filestreamingservice/"):
        return False
    return True


def version_tuple(value):
    parts = []
    for piece in re.split(r"[._-]", value):
        if piece.isdigit():
            parts.append(int(piece))
        else:
            break
    return tuple(parts) or (0,)


def parse_index(text):
    packages = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", text, re.I | re.S):
        anchor = re.search(r'<a\s+href="([^"]+)"[^>]*>(.*?)</a>', row, re.I | re.S)
        if not anchor:
            continue
        url, name = html.unescape(anchor.group(1)), html.unescape(re.sub(r"<[^>]+>", "", anchor.group(2))).strip()
        match = PACKAGE_RE.match(name)
        if not match or not official_url(url):
            continue
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.I | re.S)]
        sha1 = cells[2].lower() if len(cells) > 2 and re.fullmatch(r"[0-9a-fA-F]{40}", cells[2]) else ""
        packages.append({"version": match.group(1), "url": url, "sourceName": name, "sha1": sha1})
    return packages


def check():
    body = urllib.parse.urlencode({"type": "ProductId", "url": PRODUCT_ID, "ring": "Retail", "lang": "en-US"}).encode()
    headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://store.rg-adguard.net",
        "referer": "https://store.rg-adguard.net/",
    }
    try:
        request = urllib.request.Request(INDEX_URL, data=body, headers=headers)
        with opener().open(request, timeout=45) as response:
            if response.status != 200:
                fail(f"版本查询返回 HTTP {response.status}")
            text = response.read(2 * 1024 * 1024).decode("utf-8", "replace")
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"无法通过 OpenWrt 代理查询最新版本：{type(exc).__name__}")
    packages = parse_index(text)
    if not packages:
        fail("没有找到 ChatGPT Windows x64 安装包")
    packages.sort(key=lambda x: version_tuple(x["version"]), reverse=True)
    latest = packages[0]
    emit({
        "type": "check",
        "version": latest["version"],
        "url": latest["url"],
        "sourceName": latest["sourceName"],
        "sha1": latest["sha1"],
    })


def download(url, version, output, expected_sha1):
    if not official_url(url):
        fail("下载地址不是 Microsoft 官方 CDN")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.-]{0,80}", version or ""):
        fail("版本号格式无效")
    if not output.startswith("/app/data/tools/chatgpt/"):
        fail("下载目标目录无效")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temp = output + ".part"
    try:
        request = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
        with opener().open(request, timeout=90) as response, open(temp, "wb") as target:
            total = int(response.headers.get("content-length") or 0)
            received = 0
            digest = hashlib.sha1()
            last_percent = -1
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                percent = int(received * 100 / total) if total else 0
                if percent != last_percent:
                    emit({"type": "progress", "received": received, "total": total, "percent": percent})
                    last_percent = percent
            target.flush()
            os.fsync(target.fileno())
        actual = digest.hexdigest()
        if expected_sha1 and actual != expected_sha1:
            raise ValueError("SHA-1 校验失败")
        os.replace(temp, output)
        emit({"type": "complete", "version": version, "bytes": os.path.getsize(output), "sha1": actual, "file": os.path.basename(output)})
    except SystemExit:
        raise
    except Exception as exc:
        try:
            os.remove(temp)
        except OSError:
            pass
        fail(f"安装包下载失败：{type(exc).__name__}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["check", "download"])
    args = parser.parse_args()
    if args.command == "check":
        check()
    else:
        try:
            payload = json.load(sys.stdin)
            download(str(payload["url"]), str(payload["version"]), str(payload["output"]), str(payload.get("sha1", "")).lower())
        except (KeyError, ValueError, json.JSONDecodeError):
            fail("下载参数无效")


if __name__ == "__main__":
    main()

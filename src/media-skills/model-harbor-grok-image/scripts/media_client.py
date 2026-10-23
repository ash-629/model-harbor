#!/usr/bin/env python3
"""Model Harbor LAN media client. Python 3.9+, standard library only."""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path.home() / '.model-harbor' / 'client.json'
DEFAULT_URL = 'http://192.168.2.37:8317'


def base_url(value):
    u = urllib.parse.urlsplit(value)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
        raise ValueError('服务地址必须是 http(s) 根地址，不含账号、路径或查询参数')
    return value.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, url, key):
        self.url = base_url(url)
        self.key = key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, data=None):
        body = None if data is None else json.dumps(data).encode('utf-8')
        req = urllib.request.Request(self.url + path, data=body, headers={
            'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        try:
            return self.opener.open(req, timeout=60)
        except urllib.error.HTTPError as e:
            try:
                message = json.loads(e.read(8192)).get('error', {}).get('message', '请求失败')
            except (ValueError, AttributeError):
                message = '请求失败'
            raise ValueError('HTTP %s: %s' % (e.code, message)) from None

    def json(self, path, data=None):
        with self.request(path, data) as r:
            return json.load(r)


def reference(value):
    p = Path(value).expanduser()
    if not p.is_file() or not 0 < p.stat().st_size <= 5 * 1024 * 1024:
        raise ValueError('参考图必须是本机文件，每张不超过 5 MB')
    data = p.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif data.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        raise ValueError('参考图必须是 PNG、JPEG 或 WebP')
    return 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')


def main():
    defaults = json.loads((Path(__file__).resolve().parent.parent / 'defaults.json').read_text('utf-8'))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configure', action='store_true', help='交互配置地址和 API Key（不回显）')
    parser.add_argument('--base-url', default=os.environ.get('MODEL_HARBOR_URL'))
    parser.add_argument('--list', action='store_true', help='列出当前可用服务商')
    parser.add_argument('--provider', help='有多个同类型服务商时指定 ID')
    prompts = parser.add_mutually_exclusive_group()
    prompts.add_argument('--prompt')
    prompts.add_argument('--prompt-file', type=Path)
    parser.add_argument('--ref', action='append', default=[], help='本机参考图，最多三张')
    parser.add_argument('--aspect', default='16:9' if defaults['kind'] == 'video' else '1:1')
    parser.add_argument('--duration', type=int, choices=(6, 10, 15), default=6)
    parser.add_argument('--resolution', choices=('480p', '720p'), default='480p')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--job-id', help='查询已有任务并取回结果，不重新提交')
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text('utf-8')) if CONFIG.exists() else {}
    url = base_url(args.base_url or config.get('url') or DEFAULT_URL)
    key = os.environ.get('MODEL_HARBOR_API_KEY') or config.get('key')
    if args.configure:
        url = base_url(input('模型港地址 [%s]: ' % url).strip() or url)
        key = getpass.getpass('模型港 API Key（从网页接入指南复制，不是管理密码）: ').strip()
        if not key:
            raise ValueError('API Key 不能为空')
        Client(url, key).json('/v1/media/' + defaults['kind'] + '/providers')
        CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(CONFIG), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({'url': url, 'key': key}, f)
        os.chmod(CONFIG, 0o600)
        print('配置成功：' + str(CONFIG))
        return
    if not key:
        raise ValueError('首次使用请运行 --configure，或设置 MODEL_HARBOR_API_KEY 环境变量')
    client = Client(url, key)
    route = '/v1/media/' + defaults['kind']
    if args.list:
        print(json.dumps(client.json(route + '/providers'), ensure_ascii=False, indent=2))
        return
    if not args.output or args.timeout <= 0:
        raise ValueError('请提供 --output 本机文件路径和正数 --timeout')
    output = args.output.expanduser().resolve()
    if output.exists() and not args.overwrite:
        raise ValueError('输出文件已存在；请换文件名或显式指定 --overwrite')
    if args.job_id:
        import uuid
        job_id = str(uuid.UUID(args.job_id))
        job = client.json(route + '/jobs/' + job_id)
    else:
        prompt = args.prompt_file.read_text('utf-8-sig') if args.prompt_file else args.prompt
        if not prompt or not prompt.strip():
            raise ValueError('请提供 --prompt 或 --prompt-file')
        if len(args.ref) > 3:
            raise ValueError('最多三张参考图')
        refs = [reference(p) for p in args.ref]
        providers = [p for p in client.json(route + '/providers')['providers'] if p['type'] == defaults['providerType'] and (not args.provider or p['id'] == args.provider)]
        if len(providers) != 1:
            raise ValueError('未找到唯一可用服务商，请运行 --list 后用 --provider 指定 ID')
        data = {'providerId': providers[0]['id'], 'prompt': prompt, 'aspect': args.aspect, 'references': refs}
        if defaults['kind'] == 'video':
            data.update(duration=args.duration, resolution=args.resolution)
        job = client.json(route + '/jobs', data)
    print('任务 ID: ' + job['id'], flush=True)
    deadline = time.monotonic() + args.timeout
    previous = None
    while job['status'] in ('queued', 'running'):
        if job['status'] != previous:
            print('状态: ' + job['status'], flush=True)
            previous = job['status']
        if time.monotonic() >= deadline:
            raise ValueError('等待超时，远端任务可能仍在运行。使用 --job-id %s --output 文件路径 继续取回；不要重复生成。' % job['id'])
        time.sleep(min(3, max(0, deadline - time.monotonic())))
        job = client.json(route + '/jobs/' + job['id'])
    if job['status'] != 'completed':
        raise ValueError(job.get('error') or '远程生成失败')
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.harbor-', dir=str(output.parent))
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, 'wb') as f, client.request(route + '/files/' + job['id']) as r:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk); digest.update(chunk); size += len(chunk)
        if not size or (job.get('bytes') is not None and size != job['bytes']):
            raise ValueError('下载大小不符，请用任务 ID 重试取回')
        if args.overwrite:
            os.replace(temporary, output)
        else:
            os.link(temporary, output)
        print(json.dumps({'path': str(output), 'bytes': size, 'sha256': digest.hexdigest(), 'ext': job.get('ext'), 'jobId': job['id']}, ensure_ascii=False))
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

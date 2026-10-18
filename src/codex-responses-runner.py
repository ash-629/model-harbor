"""Fixed-endpoint Codex Responses relay. Credentials never leave this process."""
import json, os, sys, urllib.request, urllib.error, subprocess, select, time
from pathlib import Path

URL = "https://chatgpt.com/backend-api/codex/responses"
LIMIT = 64 * 1024 * 1024

def refresh_login():
    # Installed Codex owns refresh-token rotation and auth-file locking.
    process = subprocess.Popen(['codex', 'app-server', '--listen', 'stdio://'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 15
    def call(value):
        process.stdin.write((json.dumps(value) + '\n').encode())
        process.stdin.flush()
        if 'id' not in value:
            return
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], max(0, deadline-time.monotonic()))
            if not ready:
                break
            line = process.stdout.readline()
            if not line:
                break
            event = json.loads(line)
            if event.get('id') == value['id']:
                return 'error' not in event
        return False
    try:
        if not call({'id':1,'method':'initialize','params':{'clientInfo':{'name':'model_harbor','version':'0.1.0'}}}):
            return False
        call({'method':'initialized','params':{}})
        return call({'id':2,'method':'account/read','params':{'refreshToken':True}})
    except Exception:
        return False
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

def relay(body, opener=urllib.request.urlopen, auth_path=None, retried=False):
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    auth = json.loads(Path(auth_path or home / "auth.json").read_text())
    tokens = auth.get("tokens") or {}
    token = tokens.get("access_token")
    if not token:
        raise ValueError("codex_login_required")
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
               "Accept": "text/event-stream", "originator": "codex_cli_rs",
               "User-Agent": "model-harbor/0.1.0"}
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    request = urllib.request.Request(URL, data=json.dumps(body, ensure_ascii=False).encode(), headers=headers, method="POST")
    try:
        response = opener(request, timeout=600)
    except urllib.error.HTTPError as error:
        if error.code == 401 and not retried and refresh_login():
            error.close()
            return relay(body, opener, auth_path, retried=True)
        # Return only a bounded, credential-scrubbed upstream message.
        code = "codex_login_expired" if error.code == 401 else "codex_upstream_http_error"
        try:
            detail = json.loads(error.read(16384)).get('error', {})
            message = str(detail.get('message', ''))[:1000]
            for secret in [*tokens.values()]:
                if isinstance(secret, str) and secret:
                    message = message.replace(secret, '[redacted]')
        except Exception:
            message = ''
        error.close()
        print(json.dumps({"status": error.code, "code": code, "message": message}), flush=True)
        return
    with response:
        if response.headers.get("Content-Type") and "text/event-stream" not in response.headers["Content-Type"]:
            print(json.dumps({"status": 502, "code": "codex_invalid_stream"}), flush=True)
            return
        print(json.dumps({"status": 200}), flush=True)
        for line in response:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

def main():
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        print('{"status":413,"code":"request_too_large"}', flush=True)
        return
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError("invalid_request")
    relay(body)

if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
    except Exception:
        # Do not log tokens, request bodies, or exception strings.
        print('{"status":502,"code":"codex_remote_transport_error"}', flush=True)

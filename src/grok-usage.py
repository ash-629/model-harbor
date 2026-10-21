#!/usr/bin/env python3
"""Read Grok subscription usage through the official TUI's billing extension."""
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
try:
    import fcntl
    import termios
    import struct
except ImportError:
    fcntl = None


def find_billing(text):
    decoder = json.JSONDecoder()
    for match in re.finditer(r'\{"config":', text):
        try:
            value, _ = decoder.raw_decode(text[match.start():])
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and isinstance(value.get('config'), dict) and 'creditUsagePercent' in value['config']:
            return value
    return None


def main():
    with tempfile.TemporaryDirectory(prefix='grok-usage-') as tmp:
        log = Path(tmp, 'debug.log')
        socket = Path(tmp, 'leader.sock')
        master, slave = pty.openpty()
        if fcntl:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        env = os.environ.copy()
        env['TERM'] = 'xterm-256color'
        command = [
            'grok', '--no-auto-update', '--debug', '--debug-file', str(log),
            '--leader-socket', str(socket), '--no-alt-screen',
        ]
        child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=tmp, env=env, start_new_session=True)
        os.close(slave)
        try:
            deadline = time.monotonic() + 18
            next_send = time.monotonic() + 2
            while time.monotonic() < deadline:
                now = time.monotonic()
                if now >= next_send:
                    try: os.write(master, b'/usage\r')
                    except OSError: break
                    next_send = now + 5
                ready, _, _ = select.select([master], [], [], 0.5)
                if ready:
                    try: os.read(master, 65536)
                    except OSError: pass
                if log.exists():
                    value = find_billing(log.read_text(encoding='utf-8', errors='replace'))
                    if value is not None:
                        print(json.dumps(value, ensure_ascii=True), flush=True)
                        return
            print(json.dumps({'error': 'Grok usage screen did not return a weekly limit.'}), flush=True)
            sys.exit(1)
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                child.wait()
            try: os.close(master)
            except OSError: pass


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Unable to read Grok usage from the official CLI.'}), flush=True)
        sys.exit(1)

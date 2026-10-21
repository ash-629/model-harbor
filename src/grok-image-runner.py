#!/usr/bin/env python3
"""Grok subscription image runner. JSON on stdin, one JSON result on stdout."""
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

MAX_IMAGE = 20 * 1024 * 1024
ASPECTS = {
    '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4',
    '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto',
}
SYSTEM_PROMPT = (
    'You are a single-purpose image generation worker. Only the selected image tool is available. '
    'Call that tool exactly once with the supplied prompt and aspect ratio. '
    'Do not use shell, file, web, MCP, subagent, or any other tool. '
    'After the tool finishes, reply with a short confirmation.'
)


def result(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def valid_cli(value):
    return value == 'grok' or bool(re.fullmatch(r'/[A-Za-z0-9_./-]*/grok', value))


def image_files(home):
    files = []
    for path in Path(home).rglob('*'):
        if not path.is_file():
            continue
        name = path.name.lower()
        if not name.endswith(('.png', '.jpg', '.jpeg', '.webp')):
            continue
        try:
            if path.stat().st_size > 0:
                files.append(path)
        except OSError:
            continue
    return sorted(files, key=lambda path: path.stat().st_mtime_ns, reverse=True)


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    raw = sys.stdin.buffer.read(22 * 1024 * 1024 + 1)
    if len(raw) > 22 * 1024 * 1024:
        raise ValueError('Image request too large')
    body = json.loads(raw)
    grok = str(body.get('grokPath', 'grok'))
    if len(grok) > 512 or any(ord(c) < 32 for c in grok) or not valid_cli(grok):
        raise ValueError('Invalid Grok executable')

    if operation == 'check':
        version = subprocess.run([grok, '--version'], capture_output=True, timeout=15)
        models = subprocess.run([grok, 'models'], capture_output=True, timeout=30)
        logged_in = models.returncode == 0
        result({
            'ok': version.returncode == 0 and logged_in,
            'version': version.stdout.decode('utf-8', 'replace').strip()[:100],
            'loggedIn': logged_in,
        })
        return

    if operation != 'generate' or len(sys.argv) != 3 or not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[2]):
        raise ValueError('Invalid image operation')
    prompt = body.get('prompt', '')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ValueError('Invalid image prompt')
    timeout = int(body.get('timeout', 900))
    if not 30 <= timeout <= 1800:
        raise ValueError('Invalid image timeout')
    aspect = str(body.get('aspect', '1:1'))
    if aspect not in ASPECTS:
        raise ValueError('Invalid image aspect ratio')

    references = body.get('references', [])
    if not isinstance(references, list) or len(references) > 3:
        raise ValueError('At most 3 reference images are allowed')

    source_home = os.environ.get('GROK_HOME') or os.path.join(os.path.expanduser('~'), '.grok')
    source_auth = os.path.join(source_home, 'auth.json')
    if not os.path.isfile(source_auth):
        raise ValueError('Grok CLI credentials were not found. Run grok login in the target environment first.')

    with tempfile.TemporaryDirectory(prefix='grok-image-') as tmp:
        home = Path(tmp, 'home')
        grok_home = Path(tmp, 'grok-home')
        work = Path(tmp, 'work')
        home.mkdir(mode=0o700)
        grok_home.mkdir(mode=0o700)
        work.mkdir(mode=0o700)
        os.symlink(source_auth, grok_home / 'auth.json')

        reference_paths = []
        for index, value in enumerate(references):
            if not isinstance(value, str) or not re.fullmatch(r'data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*', value):
                raise ValueError('Invalid reference image')
            header, encoded = value.split(',', 1)
            image = base64.b64decode(encoded, validate=True)
            ext = header.split('/')[1].split(';')[0]
            valid = (
                (ext == 'png' and image.startswith(b'\x89PNG\r\n\x1a\n'))
                or (ext == 'jpeg' and image.startswith(b'\xff\xd8\xff'))
                or (ext == 'webp' and image[:4] == b'RIFF' and image[8:12] == b'WEBP')
            )
            if not valid or len(image) > 5 * 1024 * 1024:
                raise ValueError('Invalid or oversized reference image')
            path = work / ('reference-' + str(index + 1) + '.' + ext)
            path.write_bytes(image)
            path.chmod(0o600)
            reference_paths.append(str(path))

        tool = 'image_edit' if reference_paths else 'image_gen'
        brief = {'prompt': prompt, 'aspect_ratio': aspect}
        if reference_paths:
            brief['image'] = reference_paths
        instructions = (
            f'Call {tool} exactly once with these arguments. Do not call any other tool.\n' +
            json.dumps(brief, ensure_ascii=False) + '\nReply only with a short confirmation.'
        )
        prompt_file = Path(tmp, 'prompt.txt')
        prompt_file.write_text(instructions, encoding='utf-8')

        env = os.environ.copy()
        env['HOME'] = str(home)
        env['GROK_HOME'] = str(grok_home)
        for name in (
            'GROK_CURSOR_HOOKS_ENABLED', 'GROK_CLAUDE_SKILLS_ENABLED',
            'GROK_CLAUDE_RULES_ENABLED', 'GROK_CLAUDE_AGENTS_ENABLED',
            'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CLAUDE_HOOKS_ENABLED',
        ):
            env[name] = '0'
        if grok.startswith('/'):
            env['PATH'] = os.path.dirname(grok) + ':' + env.get('PATH', '')

        command = [
            grok, '--no-auto-update', '--prompt-file', str(prompt_file),
            '--output-format', 'json', '--permission-mode', 'dontAsk',
            '--tools', tool, '--allow', tool, '--no-plan', '--no-subagents',
            '--disable-web-search', '--max-turns', '6',
            '--system-prompt-override', SYSTEM_PROMPT, '--cwd', str(work),
        ]
        model = body.get('model')
        if model:
            model = str(model)
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}', model):
                raise ValueError('Invalid image model ID')
            command.extend(['--model', model])
        deadline = time.monotonic() + timeout
        images = []
        for attempt in range(2):
            remaining = deadline - time.monotonic()
            if remaining < 10:
                break
            with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
                child = subprocess.Popen(
                    command, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                    cwd=str(work), env=env, start_new_session=True,
                )
                def stop():
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                try:
                    try:
                        child.wait(timeout=remaining)
                    except subprocess.TimeoutExpired:
                        stop()
                        try:
                            child.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(child.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            child.wait()
                        raise ValueError('Grok image generation timed out')
                    if child.returncode:
                        err.seek(0)
                        detail = err.read(4096).decode('utf-8', 'replace')
                        if 'permission required' in detail:
                            raise ValueError('Grok image tool was blocked by a permission policy.')
                        raise ValueError('Grok image generation failed. Check subscription login, model access and tool permissions.')
                finally:
                    if child.poll() is None:
                        stop()
                        child.wait()
            images = image_files(grok_home)
            if images:
                break

        if not images:
            raise ValueError('Grok did not produce an image. Check that the image tool is available for this subscription.')
        image = images[0].read_bytes()
        if len(image) > MAX_IMAGE:
            raise ValueError('Generated image exceeds 20 MB')
        if not (
            image.startswith(b'\x89PNG\r\n\x1a\n')
            or image.startswith(b'\xff\xd8\xff')
            or (image[:4] == b'RIFF' and image[8:12] == b'WEBP')
        ):
            raise ValueError('Grok did not return a PNG, JPEG or WebP image')
        result({'image': base64.b64encode(image).decode('ascii')})


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, ValueError) else 'Cannot run Grok. Check the executable, Python installation and subscription login.'
        result({'error': message})
        sys.exit(1)

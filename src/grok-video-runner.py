#!/usr/bin/env python3
"""Grok subscription video runner. JSON on stdin, one JSON result on stdout."""
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

MAX_VIDEO = 200 * 1024 * 1024
ASPECTS = {'1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', 'auto'}
DURATIONS = {6, 10, 15}
RESOLUTIONS = {'480p', '720p'}
SYSTEM_PROMPT = (
    'You are a video generation worker. Use image_gen only when no reference image is supplied, '
    'then call reference_to_video exactly once with the supplied prompt, references and requested settings. '
    'Do not use shell, file, web, MCP, subagent, or any other tool. '
    'After the tool finishes, reply with a short confirmation.'
)


def result(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def valid_cli(value):
    return value == 'grok' or bool(re.fullmatch(r'/[A-Za-z0-9_./-]*/grok', value))


def video_files(home):
    found = []
    for path in Path(home).rglob('*'):
        if not path.is_file():
            continue
        if path.name.lower().endswith(('.mp4', '.webm', '.mov')):
            try:
                if path.stat().st_size > 0:
                    found.append(path)
            except OSError:
                continue
    return sorted(found, key=lambda path: path.stat().st_mtime_ns, reverse=True)


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    raw = sys.stdin.buffer.read(22 * 1024 * 1024 + 1)
    if len(raw) > 22 * 1024 * 1024:
        raise ValueError('Video request too large')
    body = json.loads(raw)
    grok = str(body.get('grokPath', 'grok'))
    if len(grok) > 512 or any(ord(c) < 32 for c in grok) or not valid_cli(grok):
        raise ValueError('Invalid Grok executable')

    if operation == 'check':
        version = subprocess.run([grok, '--version'], capture_output=True, timeout=15)
        models = subprocess.run([grok, 'models'], capture_output=True, timeout=30)
        result({'ok': version.returncode == 0 and models.returncode == 0,
                'version': version.stdout.decode('utf-8', 'replace').strip()[:100],
                'loggedIn': models.returncode == 0})
        return

    if operation != 'generate' or len(sys.argv) != 3 or not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[2]):
        raise ValueError('Invalid video operation')
    prompt = body.get('prompt', '')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ValueError('Invalid video prompt')
    timeout = int(body.get('timeout', 900))
    if not 30 <= timeout <= 1800:
        raise ValueError('Invalid video timeout')
    aspect = str(body.get('aspect', '16:9'))
    if aspect not in ASPECTS:
        raise ValueError('Invalid video aspect ratio')
    try:
        duration = int(body.get('duration', 6))
    except (TypeError, ValueError):
        raise ValueError('Invalid video duration')
    if duration not in DURATIONS:
        raise ValueError('Invalid video duration')
    resolution = str(body.get('resolution', '480p'))
    if resolution not in RESOLUTIONS:
        raise ValueError('Invalid video resolution')
    references = body.get('references', [])
    if not isinstance(references, list) or len(references) > 3:
        raise ValueError('At most 3 reference images are allowed')

    source_home = os.environ.get('GROK_HOME') or os.path.join(os.path.expanduser('~'), '.grok')
    source_auth = os.path.join(source_home, 'auth.json')
    if not os.path.isfile(source_auth):
        raise ValueError('Grok CLI credentials were not found. Run grok login in the target environment first.')

    with tempfile.TemporaryDirectory(prefix='grok-video-') as tmp:
        home = Path(tmp, 'home'); grok_home = Path(tmp, 'grok-home'); work = Path(tmp, 'work')
        home.mkdir(mode=0o700); grok_home.mkdir(mode=0o700); work.mkdir(mode=0o700)
        os.symlink(source_auth, grok_home / 'auth.json')
        for name in ('config.toml', 'managed_config.toml'):
            source = Path(source_home, name)
            if source.is_file():
                os.symlink(source, grok_home / name)

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
            path.write_bytes(image); path.chmod(0o600)
            reference_paths.append(str(path))

        tool_names = ['reference_to_video'] if reference_paths else ['image_gen', 'reference_to_video']
        tool_arg = ','.join(tool_names)
        brief = {'prompt': prompt, 'aspect_ratio': aspect, 'duration': duration, 'resolution_name': resolution}
        if reference_paths:
            brief['images'] = reference_paths
        if reference_paths:
            instruction = 'Call reference_to_video exactly once with these JSON arguments. Do not call any other tool.\n'
        else:
            instruction = 'Call image_gen once to create a reference still, then call reference_to_video once with that generated image and these JSON arguments. Do not call any other tool.\n'
        instructions = instruction + json.dumps(brief, ensure_ascii=False) + '\nReply only with a short confirmation.'
        prompt_file = Path(tmp, 'prompt.txt')
        prompt_file.write_text(instructions, encoding='utf-8')

        env = os.environ.copy()
        env['HOME'] = str(home); env['GROK_HOME'] = str(grok_home)
        for name in ('GROK_CURSOR_HOOKS_ENABLED', 'GROK_CLAUDE_SKILLS_ENABLED', 'GROK_CLAUDE_RULES_ENABLED',
                     'GROK_CLAUDE_AGENTS_ENABLED', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CLAUDE_HOOKS_ENABLED'):
            env[name] = '0'
        if grok.startswith('/'):
            env['PATH'] = os.path.dirname(grok) + ':' + env.get('PATH', '')

        command = [
            grok, '--no-auto-update', '--prompt-file', str(prompt_file), '--output-format', 'json',
            '--model', str(body.get('model') or 'grok-4.7'), '--permission-mode', 'dontAsk',
            '--tools', tool_arg, '--no-plan', '--no-subagents', '--disable-web-search',
            '--max-turns', '10' if not reference_paths else '8', '--system-prompt-override', SYSTEM_PROMPT,
            '--cwd', str(work),
        ]
        for tool in tool_names:
            command.extend(['--allow', tool])
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=str(work), env=env, start_new_session=True)
            def stop():
                try: os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError: pass
            try:
                try:
                    child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    stop()
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try: os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        child.wait()
                    raise ValueError('Grok video generation timed out')
            finally:
                if child.poll() is None:
                    stop(); child.wait()
            out.seek(0); err.seek(0)
            stdout = out.read().decode('utf-8', 'replace')
            stderr = err.read().decode('utf-8', 'replace')
            combined = stdout + '\n' + stderr
            if child.returncode:
                if 'permission required' in combined:
                    raise ValueError('Grok video tool was blocked by a permission policy.')
                raise ValueError('Grok video generation failed. Check subscription login, model access and tool permissions.')
            if 'zero data retention' in combined.lower() or 'output.upload_url' in combined:
                raise ValueError('Grok video generation is blocked by zero data retention. Configure a public S3-compatible output bucket or disable privacy mode.')
            videos = video_files(grok_home)
            if not videos:
                raise ValueError('Grok did not produce a video. Check that the video tool is available for this subscription.')
            video = videos[0].read_bytes()
            if len(video) > MAX_VIDEO:
                raise ValueError('Generated video exceeds 200 MB')
            ext = videos[0].suffix.lower().lstrip('.')
            result({'video': base64.b64encode(video).decode('ascii'), 'ext': ext})


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, ValueError) else 'Cannot run Grok. Check the executable, Python installation and subscription login.'
        result({'error': message})
        sys.exit(1)

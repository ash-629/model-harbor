"""Grok CLI structured client-tool runner. No credential reads or API requests."""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile

LIMIT = 64 * 1024 * 1024
SCHEMA_LIMIT = 110000
PROMPT_LIMIT = 32 * 1024 * 1024
SYSTEM_PROMPT = (
    'You are a stateless text-only reasoning service behind an API gateway. '
    'You have no tools and cannot access files, run commands, or browse. '
    'Follow the output protocol in the user message exactly. '
    'Never use built-in tool names.'
)
DENY_TOOLS = ('Bash', 'Edit', 'Read', 'Grep', 'MCPTool', 'WebFetch', 'WebSearch')


def failure_reason(details):
    # Classify explicit errors without exposing stderr, prompts or credentials.
    patterns = (
        ('auth_failed', r'not logged in|authentication failed|invalid (?:access )?token|token expired|unauthorized|http[ /:]*(?:401|403)\b'),
        ('rate_limited', r'rate.?limit|too many requests|quota exceeded|insufficient (?:credits|quota)|http[ /:]*429\b'),
        ('context_limit', r'context (?:window|length|limit)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long'),
        ('schema_rejected', r'invalid (?:json )?schema|schema (?:validation failed|not supported)|unsupported schema'),
        ('upstream_failed', r'connection (?:reset|refused)|fetch failed|network error|service unavailable|bad gateway|http[ /:]*5\d\d\b'),
    )
    for reason, pattern in patterns:
        if re.search(pattern, details, re.IGNORECASE):
            return reason
    return 'cli_failed'


def parse_output(raw):
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError('invalid_cli_output')
    if not isinstance(payload, dict):
        raise ValueError('invalid_cli_output')
    structured = payload.get('structuredOutput')
    if structured is None:
        text = payload.get('text')
        if isinstance(text, str):
            try:
                structured = json.loads(text)
            except ValueError:
                structured = None
    if not isinstance(structured, dict):
        raise ValueError('missing_structured_output')
    usage = payload.get('usage') if isinstance(payload.get('usage'), dict) else {}
    def number(key):
        value = usage.get(key, 0)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0
    return {
        'type': 'result',
        'subtype': 'success',
        'is_error': False,
        'structured_output': structured,
        'usage': {
            'input_tokens': number('input_tokens'),
            'output_tokens': number('output_tokens'),
            'cache_read_input_tokens': number('cache_read_input_tokens'),
            'cache_creation_input_tokens': number('cache_creation_input_tokens'),
        },
        'stop_reason': payload.get('stopReason'),
    }


def run(request, cli='grok'):
    if not isinstance(request, dict) or set(request) - {'model', 'timeout', 'prompt', 'schema'}:
        raise ValueError('invalid_request')
    model, timeout, prompt, schema = (request.get(k) for k in ['model', 'timeout', 'prompt', 'schema'])
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', model):
        raise ValueError('invalid_model')
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 10 <= timeout <= 600:
        raise ValueError('invalid_timeout')
    if not isinstance(prompt, str) or not prompt or len(prompt.encode()) > PROMPT_LIMIT:
        raise ValueError('invalid_prompt')
    if not isinstance(schema, dict):
        raise ValueError('invalid_payload')
    encoded = json.dumps(schema, ensure_ascii=False, separators=(',', ':'))
    if len(encoded.encode()) > SCHEMA_LIMIT:
        raise ValueError('schema_too_large')

    source_home = os.environ.get('GROK_HOME') or os.path.join(os.path.expanduser('~'), '.grok')
    source_auth = os.path.join(source_home, 'auth.json')
    if not os.path.isfile(source_auth):
        raise ValueError('missing_auth')

    with tempfile.TemporaryDirectory(prefix='grok-runner-') as tmp:
        prompt_path = os.path.join(tmp, 'prompt.txt')
        with open(prompt_path, 'w', encoding='utf-8') as handle:
            handle.write(prompt)
        isolated_home = os.path.join(tmp, 'home')
        grok_home = os.path.join(tmp, 'grok-home')
        os.mkdir(isolated_home)
        os.mkdir(grok_home)
        os.symlink(source_auth, os.path.join(grok_home, 'auth.json'))
        args = [
            cli, '--no-auto-update', '--verbatim', '--prompt-file', prompt_path,
            '--output-format', 'json', '--json-schema', encoded,
            '--model', model, '--permission-mode', 'dontAsk',
            '--no-plan', '--no-subagents', '--disable-web-search',
            '--max-turns', '1', '--tools', '',
            '--system-prompt-override', SYSTEM_PROMPT, '--cwd', tmp,
        ]
        for tool in DENY_TOOLS:
            args.extend(['--deny', tool])
        env = os.environ.copy()
        env['HOME'] = isolated_home
        env['GROK_HOME'] = grok_home
        for name in (
            'GROK_CURSOR_HOOKS_ENABLED', 'GROK_CLAUDE_SKILLS_ENABLED',
            'GROK_CLAUDE_RULES_ENABLED', 'GROK_CLAUDE_AGENTS_ENABLED',
            'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CLAUDE_HOOKS_ENABLED',
        ):
            env[name] = '0'
        if cli.startswith('/'):
            env['PATH'] = os.path.dirname(cli) + ':' + env.get('PATH', '')
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True, env=env)
            def stop(signum=None, frame=None):
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            previous = signal.signal(signal.SIGTERM, stop)
            try:
                try:
                    child.wait(timeout=timeout)
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
                    raise ValueError('timeout')
                if child.returncode:
                    err.seek(0)
                    raise ValueError(failure_reason(err.read(8192).decode('utf-8', 'replace')))
                if out.tell() > 16 * 1024 * 1024:
                    raise ValueError('output_too_large')
                out.seek(0)
                raw = out.read().decode('utf-8', 'replace')
                err.seek(0, os.SEEK_END)
                if err.tell() > 0:
                    err.seek(0)
                    details = err.read(8192).decode('utf-8', 'replace')
                    if 'permission required' in details:
                        raise ValueError('permission_denied')
                return parse_output(raw)
            finally:
                signal.signal(signal.SIGTERM, previous)
                if child.poll() is None:
                    stop()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli', default='grok')
    args = parser.parse_args()
    if args.cli != 'grok' and (not re.fullmatch(r'/[A-Za-z0-9_./-]+', args.cli) or '..' in args.cli.split('/') or not args.cli.endswith('/grok')):
        raise ValueError('invalid_cli')
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('request_too_large')
    print(json.dumps(run(json.loads(raw), args.cli), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        known = {
            'invalid_request', 'invalid_model', 'invalid_timeout', 'invalid_prompt',
            'invalid_payload', 'schema_too_large', 'timeout', 'cli_failed',
            'output_too_large', 'invalid_cli_output', 'missing_structured_output',
            'permission_denied', 'missing_auth', 'invalid_cli', 'request_too_large',
            'auth_failed', 'rate_limited', 'context_limit', 'schema_rejected', 'upstream_failed',
        }
        reason = str(error) if isinstance(error, ValueError) and str(error) in known else 'runner_failed'
        print(json.dumps({'type': 'result', 'subtype': 'error', 'is_error': True, 'bridge_error': reason}))

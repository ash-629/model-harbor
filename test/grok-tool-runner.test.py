import importlib.util, json, os, shlex, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('grok_runner', Path(__file__).parent.parent / 'src/grok-tool-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

def request():
    return {
        'model': 'grok-4.7',
        'timeout': 10,
        'prompt': 'test',
        'schema': {'type': 'object'},
    }

class Child:
    pid = 123456
    returncode = 0
    def __init__(self, output=None):
        self.output = output or {
            'text': '{"kind":"final","text":"ok","calls":[]}',
            'usage': {'input_tokens': 2, 'output_tokens': 1, 'cache_read_input_tokens': 3},
            'structuredOutput': {'kind': 'final', 'text': 'ok', 'calls': []},
        }
        self.written = False
    def wait(self, timeout=None):
        return self.returncode
    def poll(self):
        return self.returncode
    def write(self, handle):
        if self.written:
            return
        handle.write((json.dumps(self.output) + '\n').encode())
        self.written = True

class Tests(unittest.TestCase):
    def test_fixed_flags_structured_result_and_isolated_cwd(self):
        seen = {}
        child = Child()
        def wait(timeout=None):
            child.write(seen['kwargs']['stdout'])
            return 0
        child.wait = wait
        def popen(args, **kwargs):
            seen['args'] = args
            seen['kwargs'] = kwargs
            return child
        with tempfile.TemporaryDirectory() as auth_dir:
            Path(auth_dir, 'auth.json').write_text('{}')
            with patch.object(runner.subprocess, 'Popen', popen), patch.dict(os.environ, {'GROK_HOME': auth_dir}), patch.object(runner.os, 'symlink'):
                result = runner.run(request(), '/home/dev/.local/bin/grok')
        args = seen['args']
        self.assertEqual(args[0], '/home/dev/.local/bin/grok')
        self.assertIn('--no-auto-update', args)
        self.assertIn('--json-schema', args)
        self.assertEqual(args[args.index('--tools') + 1], '')
        self.assertEqual(args[args.index('--max-turns') + 1], '1')
        self.assertEqual(args[args.index('--permission-mode') + 1], 'dontAsk')
        self.assertNotEqual(args[args.index('--cwd') + 1], '/workspace')
        self.assertIn('--deny', args)
        self.assertIn('/home/dev/.local/bin', seen['kwargs']['env']['PATH'])
        self.assertNotEqual(seen['kwargs']['env']['HOME'], os.path.expanduser('~'))
        self.assertNotEqual(seen['kwargs']['env']['GROK_HOME'], os.path.join(os.path.expanduser('~'), '.grok'))
        self.assertEqual(seen['kwargs']['env']['GROK_CLAUDE_MCPS_ENABLED'], '0')
        self.assertEqual(result['structured_output']['text'], 'ok')
        self.assertEqual(result['usage']['input_tokens'], 2)
        self.assertEqual(result['usage']['cache_read_input_tokens'], 3)

    def test_bad_envelopes_fail_before_launch(self):
        values = [
            None,
            {'model': 'grok-4.7'},
            dict(request(), model='grok-4.7;touch /tmp/x'),
            dict(request(), timeout=999),
            dict(request(), timeout=True),
            dict(request(), prompt=''),
            dict(request(), schema={'description': 'x' * 120000}),
            dict(request(), images=[]),
            dict(request(), api_key='secret'),
        ]
        with patch.object(runner.subprocess, 'Popen') as launch:
            for value in values:
                with self.assertRaises(ValueError):
                    runner.run(value)
            launch.assert_not_called()

    def test_timeout_terminates_child_group(self):
        class TimedOut(Child):
            calls = 0
            def wait(self, timeout=None):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired('grok', 10)
                self.returncode = -15
                return -15
        with tempfile.TemporaryDirectory() as auth_dir:
            Path(auth_dir, 'auth.json').write_text('{}')
            with patch.object(runner.subprocess, 'Popen', return_value=TimedOut()), patch.object(runner.os, 'killpg', create=True) as kill, patch.dict(os.environ, {'GROK_HOME': auth_dir}), patch.object(runner.os, 'symlink'):
                with self.assertRaisesRegex(ValueError, 'timeout'):
                    runner.run(request())
                kill.assert_called_with(123456, runner.signal.SIGTERM)

    def test_guard_allows_only_models_and_fixed_runner(self):
        guard = Path(__file__).parent.parent / 'examples/ssh-command-guard.py'
        script = 'import os,runpy,sys; from unittest.mock import patch; ' + "\nwith patch.object(os,'execvp',lambda *a:sys.exit(0)):runpy.run_path(sys.argv[1])"
        prefix = ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', 'claude-linux']
        runner_cmd = prefix + ['timeout', '--signal=TERM', '--kill-after=5s', '610s', 'python3', '/workspace/model-harbor/grok-tool-runner.py', '--cli', '/home/dev/.local/bin/grok']
        variants = [
            (prefix + ['grok', 'models'], 0),
            (prefix + ['/home/dev/.local/bin/grok', 'models'], 0),
            (runner_cmd, 0),
            (prefix + ['grok', 'login'], 126),
            (prefix + ['bash'], 126),
            (runner_cmd[:-1] + ['/bin/sh'], 126),
        ]
        for cmd, status in variants:
            env = dict(os.environ, SSH_ORIGINAL_COMMAND=' '.join(shlex.quote(s) for s in cmd))
            result = subprocess.run([sys.executable, '-c', script, str(guard)], env=env, capture_output=True)
            self.assertEqual(result.returncode, status, result.stderr)

if __name__ == '__main__':
    unittest.main()

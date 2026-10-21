import base64, contextlib, importlib.util, io, json, os, shlex, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('grok_image_runner', Path(__file__).parent.parent / 'src/grok-image-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=')

class Stdin:
    def __init__(self, value):
        self.buffer = io.BytesIO(json.dumps(value).encode())

class Child:
    pid = 123456
    returncode = 0
    def __init__(self, seen):
        self.seen = seen
    def wait(self, timeout=None):
        home = Path(self.seen['kwargs']['env']['GROK_HOME'])
        target = home / 'sessions' / 'test' / 'images' / '1.png'
        target.parent.mkdir(parents=True)
        target.write_bytes(PNG)
        return 0
    def poll(self):
        return 0

class Tests(unittest.TestCase):
    def run_main(self, body, seen, references=False):
        output = io.StringIO()
        child = Child(seen)
        def popen(args, **kwargs):
            seen['args'] = args
            seen['kwargs'] = kwargs
            if references:
                self.assertTrue((Path(kwargs['cwd']) / 'reference-1.png').is_file())
            return child
        with tempfile.TemporaryDirectory() as auth_dir, \
             patch.object(runner.subprocess, 'Popen', popen), \
             patch.object(runner.os, 'symlink'), \
             patch.object(sys, 'argv', ['grok-image-runner.py', 'generate', '12345678-1234-1234-1234-123456789012']), \
             patch.object(sys, 'stdin', Stdin(body)), \
             patch.dict(os.environ, {'GROK_HOME': auth_dir}), \
             contextlib.redirect_stdout(output):
            Path(auth_dir, 'auth.json').write_text('{}')
            runner.main()
        return json.loads(output.getvalue())

    def test_generate_uses_image_gen_and_returns_image(self):
        seen = {}
        body = {'prompt': 'a red cube', 'aspect': '1:1', 'timeout': 60, 'grokPath': '/home/dev/.local/bin/grok', 'model': 'grok-4.7'}
        result = self.run_main(body, seen)
        self.assertTrue(result['image'])
        args = seen['args']
        self.assertEqual(args[args.index('--tools') + 1], 'image_gen')
        self.assertEqual(args[args.index('--allow') + 1], 'image_gen')
        self.assertEqual(args[args.index('--model') + 1], 'grok-4.7')
        self.assertEqual(args[args.index('--permission-mode') + 1], 'dontAsk')
        self.assertNotEqual(seen['kwargs']['env']['HOME'], os.path.expanduser('~'))

    def test_references_switch_to_image_edit(self):
        seen = {}
        data = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
        result = self.run_main({'prompt': 'make it blue', 'aspect': '1:1', 'timeout': 60, 'grokPath': 'grok', 'references': [data]}, seen, references=True)
        self.assertTrue(result['image'])
        args = seen['args']
        self.assertEqual(args[args.index('--tools') + 1], 'image_edit')
        self.assertEqual(args[args.index('--allow') + 1], 'image_edit')

    def test_invalid_cli_is_rejected(self):
        self.assertFalse(runner.valid_cli('/bin/sh'))

    def test_ssh_guard_allows_only_fixed_grok_image_runner(self):
        guard = Path(__file__).parent.parent / 'examples/ssh-command-guard.py'
        script = 'import os,runpy,sys; from unittest.mock import patch; ' + "\nwith patch.object(os,'execvp',lambda *a:sys.exit(0)):runpy.run_path(sys.argv[1])"
        prefix = ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', 'claude-linux']
        base = prefix + ['python3', '/workspace/model-harbor/grok-image-runner.py']
        variants = [
            (base + ['check'], 0),
            (base + ['generate', '12345678-1234-1234-1234-123456789012'], 0),
            (base + ['generate', '../bad'], 126),
            (prefix + ['bash'], 126),
        ]
        for cmd, status in variants:
            env = dict(os.environ, SSH_ORIGINAL_COMMAND=' '.join(shlex.quote(s) for s in cmd))
            result = subprocess.run([sys.executable, '-c', script, str(guard)], env=env, capture_output=True)
            self.assertEqual(result.returncode, status, result.stderr)

if __name__ == '__main__':
    unittest.main()

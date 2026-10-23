import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=')
ID = '12345678-1234-1234-1234-123456789012'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer test-client-key':
            self.send_response(401); self.end_headers(); return
        if '/files/' in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(PNG); return
        if self.path.endswith('/providers'):
            data = {'providers': [{'id': 'codex', 'name': 'Codex', 'type': 'codex'}, {'id': 'grok', 'name': 'Grok', 'type': 'grok'}]}
        else:
            data = {'id': ID, 'status': 'completed', 'bytes': len(PNG), 'ext': 'png'}
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        self.server.submissions.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(202); self.end_headers()
        self.wfile.write(json.dumps({'id': ID, 'status': 'queued'}).encode())


class ClientTests(unittest.TestCase):
    def test_zip_import_generation_references_resume_and_no_overwrite(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.submissions = []
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                reference = temp / 'reference.png'; reference.write_bytes(PNG)
                env = {**os.environ, 'MODEL_HARBOR_URL': 'http://127.0.0.1:' + str(server.server_port), 'MODEL_HARBOR_API_KEY': 'test-client-key', 'PYTHONIOENCODING': 'utf-8'}
                for slug in ['codex-image', 'grok-image', 'grok-video']:
                    name = 'model-harbor-' + slug
                    with zipfile.ZipFile(ROOT / 'src/media-skills' / (name + '.zip')) as z:
                        self.assertEqual(z.testzip(), None)
                        self.assertTrue(all(n.startswith(name + '/') and '..' not in n.split('/') for n in z.namelist()))
                        self.assertFalse(any('auth.json' in n or 'client.json' in n for n in z.namelist()))
                        z.extractall(temp)
                    script = temp / name / 'scripts/media_client.py'
                    output = temp / (slug + '.png')
                    result = subprocess.run([sys.executable, str(script), '--prompt', 'a boat', '--ref', str(reference), '--output', str(output)], env=env, capture_output=True, text=True, encoding='utf-8')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_bytes(), PNG)
                    self.assertNotIn('test-client-key', result.stdout + result.stderr)
                    request = server.submissions[-1]
                    self.assertEqual(request['providerId'], 'codex' if slug.startswith('codex') else 'grok')
                    self.assertEqual(request['references'][0], 'data:image/png;base64,' + base64.b64encode(PNG).decode())
                    if slug.endswith('video'):
                        self.assertEqual(request['duration'], 6); self.assertEqual(request['resolution'], '480p')
                    before = len(server.submissions)
                    result = subprocess.run([sys.executable, str(script), '--prompt', 'another', '--output', str(output)], env=env, capture_output=True)
                    self.assertNotEqual(result.returncode, 0); self.assertEqual(len(server.submissions), before)
                    result = subprocess.run([sys.executable, str(script), '--job-id', ID, '--output', str(temp / (slug + '-resume.png'))], env=env, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(len(server.submissions), before)
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == '__main__':
    unittest.main()

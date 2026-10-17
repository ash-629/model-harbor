import base64, importlib.util, io, json, os, pathlib, tempfile, uuid
from unittest.mock import patch
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=')
# Only the header matters to this fixture; no real Codex or paid API is invoked.
with tempfile.TemporaryDirectory() as root:
    os.environ['MODEL_HARBOR_IMAGE_ROOT'] = root
    spec=importlib.util.spec_from_file_location('runner','src/codex-image-runner.py')
    runner=importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
    job=str(uuid.uuid4()); folder=pathlib.Path(root)/job
    class FakeProcess:
        returncode=0
        def __init__(self, args, **kwargs):
            refs=[args[i+1] for i,arg in enumerate(args) if arg=='-i']
            assert len(refs)==3
            for ref in refs: assert pathlib.Path(ref).read_bytes()==png
        def communicate(self, data, timeout):
            assert b'referenced_image_paths' in data
            (folder/'result.png').write_bytes(png)
    body={'prompt':'combine all references','references':['data:image/png;base64,'+base64.b64encode(png).decode()]*3}
    stdin=type('Input',(),{'buffer':io.BytesIO(json.dumps(body).encode())})()
    output=io.StringIO()
    with patch.object(runner.sys,'argv',['runner','generate',job]), patch.object(runner.sys,'stdin',stdin), patch.object(runner.sys,'stdout',output), patch.object(runner.subprocess,'Popen',FakeProcess): runner.main()
    assert base64.b64decode(json.loads(output.getvalue())['image'])==png
    assert not list(folder.glob('reference-*'))
    assert not (folder/'events.tmp').exists()
print('Codex reference attachment test passed')

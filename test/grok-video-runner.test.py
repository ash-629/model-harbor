import base64, contextlib, importlib.util, io, json, os, shlex, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('grok_video_runner',Path(__file__).parent.parent/'src/grok-video-runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
MP4=bytes.fromhex('00000018667479706d703432000000006d70343269736f6d')
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=')
class Stdin:
 def __init__(self,value):self.buffer=io.BytesIO(json.dumps(value).encode())
class Child:
 pid=123456;returncode=0
 def __init__(self,seen):self.seen=seen
 def wait(self,timeout=None):
  home=Path(self.seen['kwargs']['env']['GROK_HOME']);p=home/'sessions'/'test'/'videos'/'1.mp4';p.parent.mkdir(parents=True);p.write_bytes(MP4);return 0
 def poll(self):return 0
class Tests(unittest.TestCase):
 def run_main(self,body,seen):
  out=io.StringIO();child=Child(seen)
  def popen(args,**kwargs):seen['args']=args;seen['kwargs']=kwargs;return child
  with tempfile.TemporaryDirectory() as auth_dir,patch.object(runner.subprocess,'Popen',popen),patch.object(runner.os,'symlink'),patch.object(sys,'argv',['grok-video-runner.py','generate','12345678-1234-1234-1234-123456789012']),patch.object(sys,'stdin',Stdin(body)),patch.dict(os.environ,{'GROK_HOME':auth_dir}),contextlib.redirect_stdout(out):
   Path(auth_dir,'auth.json').write_text('{}');runner.main()
  return json.loads(out.getvalue())
 def test_text_to_video_uses_image_and_reference_tools(self):
  seen={};r=self.run_main({'prompt':'a boat','aspect':'16:9','duration':6,'resolution':'480p','timeout':60,'grokPath':'grok','model':'grok-4.7'},seen)
  self.assertTrue(r['video']);args=seen['args'];self.assertEqual(args[args.index('--tools')+1],'image_gen,reference_to_video');self.assertIn('--allow',args)
 def test_references_use_reference_to_video_only(self):
  seen={};data='data:image/png;base64,'+base64.b64encode(PNG).decode();r=self.run_main({'prompt':'move','aspect':'16:9','duration':10,'resolution':'720p','timeout':60,'grokPath':'grok','references':[data]},seen)
  self.assertTrue(r['video']);args=seen['args'];self.assertEqual(args[args.index('--tools')+1],'reference_to_video')
 def test_guard_allows_video_runner_only(self):
  guard=Path(__file__).parent.parent/'examples/ssh-command-guard.py';script='import os,runpy,sys; from unittest.mock import patch; '+"\nwith patch.object(os,'execvp',lambda *a:sys.exit(0)):runpy.run_path(sys.argv[1])"
  prefix=['sudo','-n','/usr/local/bin/docker','exec','-i','claude-linux'];base=prefix+['python3','/workspace/model-harbor/grok-video-runner.py']
  variants=[(base+['check'],0),(base+['generate','12345678-1234-1234-1234-123456789012'],0),(base+['generate','../bad'],126),(prefix+['bash'],126)]
  for cmd,status in variants:
   env=dict(os.environ,SSH_ORIGINAL_COMMAND=' '.join(shlex.quote(s) for s in cmd));result=subprocess.run([sys.executable,'-c',script,str(guard)],env=env,capture_output=True);self.assertEqual(result.returncode,status,result.stderr)
if __name__=='__main__':unittest.main()

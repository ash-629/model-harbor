import importlib.util, json, os, shlex, subprocess, unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('claude_runner',Path(__file__).parent.parent/'src/claude-tool-runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

def request():
 return {'model':'sonnet','timeout':10,'prompt':'test','schema':{'type':'object'},'images':[]}

class Tests(unittest.TestCase):
 def test_only_official_cli_and_result_frame_are_returned(self):
  seen={}
  class Child:
   pid=123456;returncode=0
   def communicate(self,data,timeout):
    seen['input']=json.loads(data);seen['timeout']=timeout
    seen['out'].write((json.dumps({'type':'system','session_id':'PRIVATE_INIT','api_key':'PRIVATE_SECRET'})+'\n').encode())
    seen['out'].write((json.dumps({'type':'result','subtype':'success','is_error':False,'structured_output':{'kind':'final','text':'ok','calls':[]},'usage':{'output_tokens':1},'private':'PRIVATE_SECRET'})+'\n').encode())
   def poll(self):return self.returncode
  def popen(args,**kw):
   seen['args']=args;seen['out']=kw['stdout'];self.assertNotIn('shell',kw);self.assertTrue(kw['start_new_session']);return Child()
  r=request();r['images']=[{'type':'image','source':{'type':'base64','media_type':'image/png','data':'AAAA'}}]
  with patch.object(runner.subprocess,'Popen',popen): result=runner.run(r)
  self.assertEqual(seen['args'][0],'claude');self.assertEqual(seen['args'][seen['args'].index('--tools')+1],'')
  self.assertIn('--safe-mode',seen['args']);self.assertIn('--strict-mcp-config',seen['args']);self.assertEqual(seen['input']['message']['content'][1],r['images'][0])
  self.assertEqual(result['structured_output']['text'],'ok');self.assertNotIn('PRIVATE',json.dumps(result))

 def test_bad_envelopes_fail_before_launch(self):
  values=[None,{'model':'sonnet'},dict(request(),model='sonnet;touch /tmp/x'),dict(request(),timeout=999),dict(request(),timeout=True),dict(request(),schema={'description':'x'*120000}),dict(request(),images=[{'type':'image','source':{'type':'url','url':'http://example.test/x'}}]),dict(request(),api_key='secret')]
  with patch.object(runner.subprocess,'Popen') as launch:
   for value in values:
    with self.assertRaises(ValueError):runner.run(value)
   launch.assert_not_called()

 def test_timeout_terminates_child_group_without_leaking_output(self):
  class Child:
   pid=123456;returncode=None
   def communicate(self,*a,**kw):raise subprocess.TimeoutExpired('claude',10)
   def wait(self,timeout=None):self.returncode=-15;return -15
   def poll(self):return self.returncode
  with patch.object(runner.subprocess,'Popen',return_value=Child()),patch.object(runner.os,'killpg') as kill:
   with self.assertRaisesRegex(ValueError,'timeout'):runner.run(request())
   kill.assert_called_once_with(123456,runner.signal.SIGTERM)

 def test_ssh_guard_only_allows_fixed_tool_runner_and_keeps_oauth_denied(self):
  guard=Path(__file__).parent.parent/'nas-ssh-guard.py'
  script='import os,runpy,sys; from unittest.mock import patch; '+"\nwith patch.object(os,'execvp',lambda *a:sys.exit(0)):runpy.run_path(sys.argv[1])"
  prefix=['sudo','-n','/usr/local/bin/docker','exec','-i','claude-linux']
  fixed=prefix+['timeout','--signal=TERM','--kill-after=5s','610s','python3','/workspace/model-harbor/claude-tool-runner.py','--cli','claude']
  variants=[(fixed,0),(fixed+['--anything'],126),(fixed[:-1]+['/bin/sh'],126),(prefix+['python3','/workspace/model-harbor/claude-oauth-runner.py'],126)]
  for cmd,status in variants:
   env=dict(os.environ,SSH_ORIGINAL_COMMAND=' '.join(shlex.quote(s) for s in cmd))
   result=subprocess.run(['python3','-c',script,str(guard)],env=env,capture_output=True)
   self.assertEqual(result.returncode,status,result.stderr)

if __name__=='__main__':unittest.main()

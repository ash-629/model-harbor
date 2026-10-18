
import importlib.util, io, json, tempfile, unittest, urllib.error
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',Path(__file__).parent.parent/'src/codex-responses-runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class Output:
    def __init__(self): self.buffer=io.BytesIO()
    def write(self,text): self.buffer.write(text.encode()); return len(text)
    def flush(self): pass
class Reply:
    headers={'Content-Type':'text/event-stream'}
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def __iter__(self): return iter([b'event: response.completed\ndata: {}\n\n'])
class Tests(unittest.TestCase):
    def test_fixed_destination_and_secrets_remain_remote(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'auth.json';p.write_text(json.dumps({'tokens':{'access_token':'SECRET','account_id':'ACCOUNT'}}))
            out=Output();seen=[]
            def opener(req,timeout): seen.append(req);return Reply()
            with patch.object(runner.sys,'stdout',out): runner.relay({'input':'x'},opener,p)
            text=out.buffer.getvalue().decode()
            self.assertEqual(seen[0].full_url,runner.URL)
            self.assertEqual(seen[0].get_header('Authorization'),'Bearer SECRET')
            self.assertNotIn('SECRET',text);self.assertNotIn('ACCOUNT',text)
            self.assertIn('response.completed',text)
    def test_401_refreshes_once_and_scrubs_all_tokens(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'auth.json';p.write_text(json.dumps({'tokens':{'access_token':'SECRET','refresh_token':'REFRESH'}}))
            out=Output();calls=[]
            def opener(req,timeout):
                calls.append(1)
                raise urllib.error.HTTPError(runner.URL,401,'bad',{},io.BytesIO(b'{"error":{"message":"SECRET REFRESH expired"}}'))
            with patch.object(runner.sys,'stdout',out),patch.object(runner,'refresh_login',return_value=True) as refresh:
                runner.relay({'input':'x'},opener,p)
            self.assertEqual(len(calls),2);refresh.assert_called_once()
            text=out.buffer.getvalue().decode()
            self.assertNotIn('SECRET',text);self.assertNotIn('REFRESH',text)
            self.assertIn('codex_login_expired',text)
if __name__=='__main__': unittest.main()

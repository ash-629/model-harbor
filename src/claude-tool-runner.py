"""CT-05: fixed CLI runner. No credential reads, API requests or client tool execution."""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile

LIMIT = 64 * 1024 * 1024

def run(request, cli='claude'):
    if not isinstance(request, dict) or set(request) - {'model','timeout','prompt','schema','images'}:
        raise ValueError('invalid_request')
    model, timeout, prompt, schema = (request.get(k) for k in ['model','timeout','prompt','schema'])
    if not isinstance(model,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}',model):
        raise ValueError('invalid_model')
    if not isinstance(timeout,(int,float)) or isinstance(timeout,bool) or not 10 <= timeout <= 600:
        raise ValueError('invalid_timeout')
    if not isinstance(prompt,str) or not isinstance(schema,dict):
        raise ValueError('invalid_payload')
    encoded = json.dumps(schema,ensure_ascii=False,separators=(',',':'))
    if len(encoded.encode()) > 110000:
        raise ValueError('schema_too_large')
    images = request.get('images',[])
    if not isinstance(images,list) or len(images)>20:
        raise ValueError('invalid_images')
    for image in images:
        source = image.get('source',{}) if isinstance(image,dict) else {}
        if image.get('type')!='image' or source.get('type')!='base64' or source.get('media_type') not in ['image/png','image/jpeg','image/webp','image/gif'] or not isinstance(source.get('data'),str):
            raise ValueError('invalid_image')
    args = [cli,'-p','--output-format','stream-json','--verbose','--input-format','stream-json',
            '--no-session-persistence','--safe-mode','--strict-mcp-config','--tools','',
            '--permission-mode','dontAsk','--permission-prompts','none','--model',model,'--json-schema',encoded]
    message={'type':'user','message':{'role':'user','content':[{'type':'text','text':prompt}]+images}}
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=out,stderr=err,start_new_session=True)
        def stop(signum=None, frame=None):
            try: os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError: pass
        previous=signal.signal(signal.SIGTERM,stop)
        try:
            try: child.communicate((json.dumps(message,ensure_ascii=False)+'\n').encode(),timeout=timeout)
            except subprocess.TimeoutExpired:
                stop()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try: os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                    child.wait()
                raise ValueError('timeout')
            if child.returncode: raise ValueError('cli_failed')
            if out.tell()>8*1024*1024: raise ValueError('output_too_large')
            out.seek(0)
            result=None
            for line in out:
                try: item=json.loads(line)
                except (ValueError,UnicodeError): continue
                if item.get('type')=='result': result=item
            if result is None: raise ValueError('missing_result')
            # Neither system/init frames nor stderr are returned to the gateway.
            return {k:result[k] for k in ['type','subtype','is_error','result','structured_output','usage','api_error_status'] if k in result}
        finally:
            signal.signal(signal.SIGTERM,previous)
            if child.poll() is None:
                stop()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid,signal.SIGKILL);child.wait()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cli',default='claude')
    args=parser.parse_args()
    if args.cli!='claude' and (not re.fullmatch(r'/[A-Za-z0-9_./-]+',args.cli) or '..' in args.cli.split('/')):
        raise ValueError('invalid_cli')
    raw=sys.stdin.buffer.read(LIMIT+1)
    if len(raw)>LIMIT: raise ValueError('request_too_large')
    print(json.dumps(run(json.loads(raw),args.cli),ensure_ascii=False))

if __name__=='__main__':
    try: main()
    except Exception as error:
        known={'invalid_request','invalid_model','invalid_timeout','invalid_payload','schema_too_large','invalid_images','invalid_image','timeout','cli_failed','output_too_large','missing_result','invalid_cli','request_too_large'}
        reason=str(error) if isinstance(error,ValueError) and str(error) in known else 'runner_failed'
        print(json.dumps({'type':'result','subtype':'error','is_error':True,'bridge_error':reason}))

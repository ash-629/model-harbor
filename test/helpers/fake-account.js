import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
// Entirely in-memory account service. Never starts SSH or a real Codex process.
export function fakeAccount(snapshot, {fail=false, hang=false, outcome='reset', loseResultOnce=false, failRefresh=false} = {}) {
  const children=[], calls=[], redeemed=new Set(); let lost=false, consumed=0;
  const launch=()=>{
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.killed=false;
    child.stdin=new Writable({write(bytes, enc, done) {
      const value=JSON.parse(bytes.toString()); calls.push(value);
      if (value.id && !hang) queueMicrotask(()=>{
        let result={}, error;
        if (value.method==='account/rateLimitResetCredit/consume') {
          const key=value.params.idempotencyKey;
          result={outcome:redeemed.has(key)?'alreadyRedeemed':outcome};
          if (result.outcome==='reset') {redeemed.add(key);consumed++;}
          if (loseResultOnce && !lost) {lost=true;error={message:'lost response'};}
        } else if (value.method==='account/rateLimits/read') {
          result=structuredClone(snapshot); result.rateLimitResetCredits.availableCount-=consumed;
          if (fail || (failRefresh && consumed)) error={message:'private backend credentials'};
        }
        child.stdout.write(JSON.stringify({id:value.id,...(error?{error}:{result})})+'\n');
      });
      done();
    }});
    child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',0));};children.push(child);return child;
  };
  return {launch,children,calls,consumed:()=>consumed};
}

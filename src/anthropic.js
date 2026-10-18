// Anthropic Messages ingress over structured Responses routes.
import {PassThrough} from 'node:stream';
import {HttpError} from './store.js';
import {sseEvents,openSSE,writeSSE,uid} from './protocol.js';
const bad=m=>{throw new HttpError(400,m,'invalid_request_error');};
function content(b,assistant=false){
 if(b.type==='text'&&typeof b.text==='string')return {type:assistant?'output_text':'input_text',text:b.text};
 if(assistant&&b.type==='thinking'){if(typeof b.thinking!=='string')bad('Invalid thinking block');return {type:'output_text',text:b.thinking};}
 if(assistant&&b.type==='redacted_thinking')return null;
 if(!assistant&&b.type==='image'){
  const s=b.source;
  if(s?.type==='base64'&&['image/png','image/jpeg','image/webp','image/gif'].includes(s.media_type)&&typeof s.data==='string')return {type:'input_image',image_url:`data:${s.media_type};base64,${s.data}`};
  if(s?.type==='url'&&typeof s.url==='string'&&/^https?:\/\//.test(s.url))return {type:'input_image',image_url:s.url};
 }
 bad('Unsupported Anthropic content block: '+String(b.type));
}
export function toResponses(b){
 if(!Number.isSafeInteger(b.max_tokens)||b.max_tokens<=0)bad('max_tokens must be a positive integer');
 if(typeof b.model!=='string'||!Array.isArray(b.messages)||!b.messages.length)bad('model and messages are required');
 if(b.stream!==undefined&&typeof b.stream!=='boolean')bad('stream must be boolean');
 const thinking=b.thinking?.type;
 if(thinking!==undefined&&!['enabled','adaptive','disabled'].includes(thinking))bad('Invalid thinking configuration');
 // Client-side context managers and hosted containers have no Responses
 // equivalent. Their history is already complete, so accept the declaration
 // and avoid blocking the request.
 if(b.stop_sequences!=null&&(!Array.isArray(b.stop_sequences)||b.stop_sequences.length))bad('stop_sequences is unsupported');
 const input=[];
 for(const m of b.messages){
  if(!['user','assistant','system'].includes(m.role))bad('Messages roles must be user, assistant or system');
  const role=m.role==='system'?'developer':m.role;
  const blocks=typeof m.content==='string'?[{type:'text',text:m.content}]:m.content;
  if(!Array.isArray(blocks))bad('Invalid message content');
  let parts=[];const flush=()=>{if(parts.length)input.push({role,content:parts});parts=[];};
  for(const c of blocks){
   if(c.type==='tool_use'){
    if(m.role!=='assistant'||typeof c.id!=='string'||typeof c.name!=='string'||!c.input||typeof c.input!=='object'||Array.isArray(c.input))bad('Invalid tool_use');
    flush();input.push({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.input)});
   }else if(c.type==='tool_result'){
    if(m.role!=='user'||typeof c.tool_use_id!=='string')bad('Invalid tool_result');
    flush();let output=typeof c.content==='string'?c.content:Array.isArray(c.content)?c.content.map(x=>content(x)):c.content==null?'':bad('Invalid tool result content');
    if(c.is_error)output=typeof output==='string'?'[Tool error]\n'+output:[{type:'input_text',text:'[Tool error]'},...output];
    input.push({type:'function_call_output',call_id:c.tool_use_id,output});
   }else {const part=content(c,m.role==='assistant');if(part)parts.push(part);}
  }flush();
 }
 if(b.tools!==undefined&&!Array.isArray(b.tools))bad('tools must be an array');
 const tools=(b.tools||[]).map(t=>{if(t.type&&t.type!=='custom')bad('Server-side Anthropic tools are unsupported');if(typeof t.name!=='string'||t.input_schema?.type!=='object')bad('Tools require name and object input_schema');return {type:'function',name:t.name,description:t.description||'',parameters:t.input_schema};});
 let choice='auto';
 if(b.tool_choice){if(b.tool_choice.type==='any')choice='required';else if(b.tool_choice.type==='tool'&&typeof b.tool_choice.name==='string')choice={type:'function',name:b.tool_choice.name};else if(['auto','none'].includes(b.tool_choice.type))choice=b.tool_choice.type;else bad('Unsupported tool_choice');}
 const r={model:b.model,input,tools,tool_choice:choice,max_output_tokens:b.max_tokens,stream:b.stream===true,store:false};
 if(b.system!=null){if(typeof b.system==='string')r.instructions=b.system;else if(Array.isArray(b.system)&&b.system.every(x=>x.type==='text'&&typeof x.text==='string'))r.instructions=b.system.map(x=>x.text).join('\n');else bad('system must contain text');}
 for(const k of ['temperature','top_p'])if(b[k]!=null)r[k]=b[k];
 if(b.top_k!=null)bad('top_k is unsupported');
 // Match the Responses gateway shape. Subscription Codex selects its own
 // sampling values; requested thinking becomes a reasoning effort hint.
 if(thinking==='enabled'||thinking==='adaptive'){const budget=b.thinking.budget_tokens;r.reasoning={effort:typeof budget==='number'&&budget>=24000?'high':'medium'};}
 if(b.tool_choice?.disable_parallel_tool_use!==undefined)r.parallel_tool_calls=!b.tool_choice.disable_parallel_tool_use;
 return r;
}
export function usage(u){const cached=u?.input_tokens_details?.cached_tokens||0;return {input_tokens:Math.max(0,(u?.input_tokens||0)-cached),output_tokens:u?.output_tokens||0,cache_creation_input_tokens:0,cache_read_input_tokens:cached};}
function stop(r){if(r.output?.some(i=>['function_call','custom_tool_call'].includes(i.type)))return 'tool_use';if(r.incomplete_details?.reason==='max_output_tokens')return 'max_tokens';if(r.status==='incomplete')throw new HttpError(502,'Upstream response incomplete','api_error');return 'end_turn';}
export function fromResponses(r,model){
 const blocks=[];
 for(const i of r.output||[]){
  if(i.type==='message')for(const p of i.content||[])if(p.type==='output_text'||p.type==='refusal')blocks.push({type:'text',text:p.text??p.refusal});
  if(['function_call','custom_tool_call'].includes(i.type)){let input;try{input=i.type==='custom_tool_call'?{input:i.input}:JSON.parse(i.arguments||'{}');}catch{throw new HttpError(502,'Invalid upstream tool arguments','api_error');}blocks.push({type:'tool_use',id:i.call_id,name:i.name,input});}
 }return {id:r.id||uid('msg_'),type:'message',role:'assistant',model,content:blocks,stop_reason:stop(r),stop_sequence:null,usage:usage(r.usage)};
}
export async function sendMessages(body,res,invoke){
 const request=toResponses(body);if(!body.stream)return fromResponses(await invoke(request,res),body.model);
 const sink=new PassThrough();sink.writeHead=()=>{};sink.flushHeaders=()=>{};
 const producer=Promise.resolve().then(()=>invoke(request,sink)).then(()=>{if(!sink.writableEnded)sink.end();},e=>sink.destroy(e));
 let opened=false,messageStarted=false,terminal=false,index=0;const blocks=new Map();
 const emit=async(type,fields)=>{if(!opened){openSSE(res);opened=true;}await writeSSE(res,{type,...fields},type);};
 const start=async(key,block)=>{if(blocks.has(key))return blocks.get(key);const e={index:index++,closed:false};blocks.set(key,e);await emit('content_block_start',{index:e.index,content_block:block});return e;};
 const close=async e=>{if(e&&!e.closed){e.closed=true;await emit('content_block_stop',{index:e.index});}};
 try{
  for await(const event of sseEvents(sink)){
   if(event.data==='[DONE]')continue;const d=JSON.parse(event.data);
   if(d.type==='error'||d.type==='response.failed')throw new HttpError(502,'Upstream inference failed','api_error');
   if(!messageStarted){messageStarted=true;await emit('message_start',{message:{id:d.response?.id||uid('msg_'),type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:usage(d.response?.usage)}});}
   const key='text:'+d.output_index+':'+(d.content_index||0),toolKey='tool:'+d.output_index;
   if(d.type==='response.output_item.added'&&['function_call','custom_tool_call'].includes(d.item?.type))await start(toolKey,{type:'tool_use',id:d.item.call_id,name:d.item.name,input:{}});
   if(['response.output_text.delta','response.refusal.delta'].includes(d.type)){const e=await start(key,{type:'text',text:''});await emit('content_block_delta',{index:e.index,delta:{type:'text_delta',text:d.delta}});}
   if(d.type==='response.function_call_arguments.delta'){const e=blocks.get(toolKey);if(!e)throw new HttpError(502,'Tool delta without start','api_error');await emit('content_block_delta',{index:e.index,delta:{type:'input_json_delta',partial_json:d.delta}});}
   if(d.type==='response.content_part.done')await close(blocks.get(key));
   if(d.type==='response.output_item.done')await close(blocks.get(toolKey));
   if(['response.completed','response.incomplete'].includes(d.type)){for(const e of blocks.values())await close(e);await emit('message_delta',{delta:{stop_reason:stop(d.response),stop_sequence:null},usage:usage(d.response.usage)});await emit('message_stop',{});terminal=true;}
  }await producer;if(!terminal)throw new HttpError(502,'Upstream ended without a completed response','api_error');res.end();return null;
 }finally{sink.destroy();}
}
export const errorType=s=>s===401?'authentication_error':s===403?'permission_error':s===404?'not_found_error':s===413?'request_too_large':s===429?'rate_limit_error':s>=500?'api_error':'invalid_request_error';

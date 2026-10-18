// CT-03: validate JSON Schema constraints before emitting client actions.
// format/content annotations remain annotations; custom grammars are hints.
import { HttpError } from './store.js';
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>{
  if(a===b)return true;
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
  if(obj(a)&&obj(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
  return false;
};
export function matchesSchema(value,schema,root=schema,depth=0){
  if(depth>128)return false;
  if(typeof schema==='boolean')return schema;
  if(!obj(schema))return false;
  const test=(v,s)=>matchesSchema(v,s,root,depth+1);
  if(schema.$ref){
    if(typeof schema.$ref!=='string'||!(schema.$ref==='#'||schema.$ref.startsWith('#/')))return false;
    let target=root;
    for(const key of schema.$ref.slice(2).split('/').filter((_,i)=>schema.$ref!=='#')){
      const part=decodeURIComponent(key).replace(/~1/g,'/').replace(/~0/g,'~');
      if(!obj(target)&&!Array.isArray(target)||!Object.hasOwn(target,part))return false;
      target=target[part];
    }
    if(!test(value,target))return false;
  }
  if(schema.type){
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    const kind=t=>t==='null'?value===null:t==='object'?obj(value):t==='array'?Array.isArray(value):t==='integer'?Number.isInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):t==='string'?typeof value==='string':t==='boolean'?typeof value==='boolean':false;
    if(!types.some(kind))return false;
  }
  if(schema.enum&&!schema.enum.some(v=>same(v,value)))return false;
  if(Object.hasOwn(schema,'const')&&!same(schema.const,value))return false;
  if(schema.allOf&&!schema.allOf.every(s=>test(value,s)))return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>test(value,s)))return false;
  if(schema.oneOf&&schema.oneOf.filter(s=>test(value,s)).length!==1)return false;
  if(Object.hasOwn(schema,'not')&&test(value,schema.not))return false;
  if(Object.hasOwn(schema,'if')){const branch=test(value,schema.if)?schema.then:schema.else;if(branch!==undefined&&!test(value,branch))return false;}
  if(obj(value)){
    const keys=Object.keys(value);
    if(schema.required?.some(k=>!Object.hasOwn(value,k)))return false;
    if(schema.minProperties!==undefined&&keys.length<schema.minProperties||schema.maxProperties!==undefined&&keys.length>schema.maxProperties)return false;
    for(const key of keys){
      if(Object.hasOwn(schema,'propertyNames')&&!test(key,schema.propertyNames))return false;
      let covered=false;
      if(schema.properties&&Object.hasOwn(schema.properties,key)){covered=true;if(!test(value[key],schema.properties[key]))return false;}
      for(const [pattern,s] of Object.entries(schema.patternProperties||{})){let match;try{match=new RegExp(pattern,'u').test(key);}catch{return false;}if(match){covered=true;if(!test(value[key],s))return false;}}
      if(!covered&&schema.additionalProperties!==undefined&&!test(value[key],schema.additionalProperties))return false;
    }
    for(const [key,requirements] of Object.entries(schema.dependentRequired||{}))if(Object.hasOwn(value,key)&&requirements.some(k=>!Object.hasOwn(value,k)))return false;
    for(const [key,s] of Object.entries(schema.dependentSchemas||{}))if(Object.hasOwn(value,key)&&!test(value,s))return false;
    for(const [key,s] of Object.entries(schema.dependencies||{}))if(Object.hasOwn(value,key)&&(Array.isArray(s)?s.some(k=>!Object.hasOwn(value,k)):!test(value,s)))return false;
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)return false;
    if(schema.uniqueItems&&value.some((v,i)=>value.slice(0,i).some(w=>same(v,w))))return false;
    const tuple=schema.prefixItems||(Array.isArray(schema.items)?schema.items:null);
    if(tuple&&value.some((v,i)=>i<tuple.length&&!test(v,tuple[i])))return false;
    const rest=Array.isArray(schema.items)?schema.additionalItems:schema.items;
    if(rest!==undefined&&value.some((v,i)=>(!tuple||i>=tuple.length)&&!test(v,rest)))return false;
    if(Object.hasOwn(schema,'contains')){const count=value.filter(v=>test(v,schema.contains)).length;if(count<(schema.minContains??1)||schema.maxContains!==undefined&&count>schema.maxContains)return false;}
  }
  if(typeof value==='string'){
    const size=Array.from(value).length;
    if(schema.minLength!==undefined&&size<schema.minLength||schema.maxLength!==undefined&&size>schema.maxLength)return false;
    if(schema.pattern){try{if(!new RegExp(schema.pattern,'u').test(value))return false;}catch{return false;}}
  }
  if(typeof value==='number'){
    if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)return false;
    if(typeof schema.exclusiveMinimum==='number'&&value<=schema.exclusiveMinimum||typeof schema.exclusiveMaximum==='number'&&value>=schema.exclusiveMaximum)return false;
    if(schema.exclusiveMinimum===true&&value<=schema.minimum||schema.exclusiveMaximum===true&&value>=schema.maximum)return false;
    if(schema.multipleOf){const q=value/schema.multipleOf;if(Math.abs(q-Math.round(q))>1e-9)return false;}
  }
  return true;
}
export function validateToolArguments(args,schema){
  if(!matchesSchema(args,schema))throw new HttpError(502,'Claude 工具参数不符合客户端 schema，未发送工具调用','invalid_tool_arguments');
}

import { HttpError } from './store.js';
export const isWebSearch = tool => ['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'].includes(tool?.type);
const bad = message => { throw new HttpError(400, message, 'unsupported_parameter'); };
export function nativeSearch(tools, choice) {
  const entries = tools.filter(isWebSearch), forced = isWebSearch(choice);
  if (entries.length > 1) bad('只能声明一个原生 web_search 工具');
  if (forced && !entries.some(t => t.type === choice.type)) bad('tool_choice 指定的工具不存在');
  const tool = entries[0];
  if (!tool || choice === 'none' || (choice && typeof choice === 'object' && !forced)) return { mode:'disabled' };
  for (const [key, value] of Object.entries(tool)) if (value != null && !['type','external_web_access','search_context_size','search_content_types','user_location','filters'].includes(key)) bad('原生搜索暂不支持参数 ' + key);
  let imageRequested = false, imageOnly = false;
  if (tool.search_content_types != null) {
    if (!Array.isArray(tool.search_content_types) || tool.search_content_types.some(type => !['text','image'].includes(type))) bad('search_content_types 必须为 text/image 数组');
    imageRequested = tool.search_content_types.includes('image');
    imageOnly = imageRequested && !tool.search_content_types.includes('text');
    if (imageOnly && (forced || choice === 'required')) bad('当前远程 Codex 不支持原生图片搜索；请使用客户端的图片搜索工具或支持图片搜索的原生 API 上游');
  }
  if (tool.external_web_access != null && typeof tool.external_web_access !== 'boolean') bad('external_web_access 必须为布尔值');
  const options = {};
  if (tool.search_context_size != null) {
    if (!['low','medium','high'].includes(tool.search_context_size)) bad('无效的搜索上下文大小');
    options.context_size = tool.search_context_size;
  }
  if (tool.filters != null) {
    if (tool.type !== 'web_search' || !Array.isArray(tool.filters.allowed_domains) || Object.keys(tool.filters).some(k => k !== 'allowed_domains') || tool.filters.allowed_domains.length > 100 || tool.filters.allowed_domains.some(d => typeof d !== 'string' || !/^(?:\*\.)?[A-Za-z0-9.-]+$/.test(d))) bad('无效的搜索域名过滤条件');
    options.allowed_domains = tool.filters.allowed_domains;
  }
  if (tool.user_location != null) {
    const {type, ...fields} = tool.user_location, location = Object.fromEntries(Object.entries(fields).filter(([,value]) => value != null));
    if ((type && type !== 'approximate') || Object.entries(location).some(([k,v]) => !['country','region','city','timezone'].includes(k) || typeof v !== 'string' || v.length > 128)) bad('无效的搜索位置设置');
    options.location = location;
  }
  return {mode:imageOnly ? 'disabled' : tool.type !== 'web_search' || tool.external_web_access !== false ? 'live' : 'cached', options,
    ...(imageRequested ? {unsupportedContentTypes:['image']} : {})};
}
export function searchItem(item) {
  const source = item.action || {type:'search',query:item.query};
  const action = source.type === 'openPage' ? {type:'open_page',url:source.url || ''} : source.type === 'findInPage' ? {type:'find_in_page',url:source.url || '',pattern:source.pattern || ''} : {type:'search',query:source.query || item.query || '', ...(source.queries ? {queries:source.queries} : {})};
  return {id:item.id, type:'web_search_call',status:'completed',action};
}

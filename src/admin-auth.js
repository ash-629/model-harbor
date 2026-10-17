// Persistent single-user management credentials; never return password material.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './store.js';
const scrypt = promisify(crypto.scrypt);
const equal = (a,b) => a.length === b.length && crypto.timingSafeEqual(a,b);
export class AdminAuth {
  constructor(store, bootstrapPassword) { this.store=store; this.bootstrapPassword=bootstrapPassword; this.cached=null; }
  get settings() { return this.store.data.settings || {}; }
  get username() { return this.settings.username || 'admin'; }
  get configured() { return Boolean(this.settings.passwordHash || this.bootstrapPassword); }
  get enabled() { return this.settings.loginEnabled ?? this.configured; }
  public() { return {loginEnabled:this.enabled, canEnableLogin:this.configured, username:this.username}; }
  async accepts(header) {
    if (typeof header !== 'string' || header.length > 4096 || !header.startsWith('Basic ')) return false;
    const fingerprint=crypto.createHash('sha256').update(header).digest();
    if (this.cached && equal(this.cached,fingerprint)) return true;
    const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'), colon=decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0,colon) !== this.username) return false;
    const password=decoded.slice(colon+1);
    if (password.length > 256) return false;
    const credentials=this.store.data.settings;
    let valid=false;
    if (this.settings.passwordHash) {
      const [salt,hash]=this.settings.passwordHash.split(':');
      const result=await scrypt(password,Buffer.from(salt,'hex'),64);
      valid=equal(result,Buffer.from(hash,'hex'));
    } else if (this.bootstrapPassword) valid=equal(Buffer.from(password),Buffer.from(this.bootstrapPassword));
    if (credentials !== this.store.data.settings) return false;
    if (valid) this.cached=fingerprint;
    return valid;
  }
  async update(input) {
    if (typeof input.loginEnabled !== 'boolean') throw new HttpError(400,'登录开关必须为布尔值');
    const username=input.username === undefined ? this.username : input.username;
    if (typeof username !== 'string' || !/^[^\s:\x00-\x1f\x7f]{1,64}$/.test(username)) throw new HttpError(400,'用户名须为 1–64 个字符，不能包含空格、冒号或控制字符');
    const password=input.password ?? '';
    if (typeof password !== 'string' || (password && (password.length < 8 || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)))) throw new HttpError(400,'新密码须为 8–256 个字符，不能包含控制字符');
    const previous=this.store.data.settings;
    const next={...previous,username,loginEnabled:input.loginEnabled};
    if (password) { const salt=crypto.randomBytes(16);next.passwordHash=salt.toString('hex')+':'+Buffer.from(await scrypt(password,salt,64)).toString('hex'); }
    if (input.loginEnabled && !next.passwordHash && !this.bootstrapPassword) throw new HttpError(400,'请先设置登录密码');
    const credentialsChanged=username !== this.username || Boolean(password);
    this.store.data.settings=next;
    try { this.store.save(); } catch(error) { this.store.data.settings=previous;throw error; }
    this.cached=null;
    return {...this.public(),credentialsChanged};
  }
}

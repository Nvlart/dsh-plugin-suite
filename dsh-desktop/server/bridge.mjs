import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class Bridge {
  constructor({url,token,ledger,timeout=10000}) {
    const u=new URL(url);
    if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash) throw Error('Control URL must be loopback HTTP without credentials/query');
    if(typeof token!=='string'||token.length<16) throw Error('Control token must have at least 16 characters');
    this.url=url.replace(/\/$/,'');this.token=token;this.ledger=resolve(ledger);this.timeout=timeout;
    this.data=existsSync(this.ledger)?JSON.parse(readFileSync(this.ledger,'utf8')):{version:1,entries:[]};
    if(this.data.version!==1||!Array.isArray(this.data.entries)) throw Error('Invalid ledger; refusing to dispatch');
    this.serial=Promise.resolve();
  }
  save(){mkdirSync(dirname(this.ledger),{recursive:true});writeFileSync(this.ledger+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600});renameSync(this.ledger+'.tmp',this.ledger);}
  async request(path,args){
    const r=await fetch(this.url+'/'+path,{method:args===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:args===undefined?undefined:JSON.stringify(args),signal:AbortSignal.timeout(this.timeout)});
    const b=await r.json();if(!r.ok||b.ok===false)throw Error(b.error?.code||'CONTROL_HTTP_'+r.status);
    if(b.ok!==true||!b.data||typeof b.data!=='object')throw Error('INVALID_CONTROL_RESPONSE');return b.data;
  }
  async health(){return this.request('health');}
  send(args){const result=this.serial.then(()=>this._send(args));this.serial=result.catch(()=>{});return result;}
  async _send(args){
    const key=args.idempotency_key;if(typeof key!=='string'||!key.trim()||key.length>200)throw Error('A stable idempotency_key is required');
    const fingerprint=hash({...args,idempotency_key:undefined});
    const prior=this.data.entries.find(e=>e.key===key);
    if(prior){if(prior.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return {task_id:prior.task_id??null,state:prior.state,duplicate:true,dispatch_confirmed:!!prior.task_id};}
    if(this.data.entries.some(e=>!['completed','failed'].includes(e.state)))throw Error('UNRESOLVED_DISPATCH: inspect earlier task before sending more work');
    const health=await this.health();if(!health.startedAt)throw Error('HOST_IDENTITY_UNAVAILABLE');
    const entry={key,fingerprint,host:health.startedAt,state:'dispatching',createdAt:new Date().toISOString()};
    this.data.entries.push(entry);this.save();
    try{
      const raw=await this.request('send',args);
      const task=raw.task??raw;
      const result={...task,task_id:task.task_id??task.taskId,session_id:task.session_id??task.sessionId,duplicate:raw.duplicate===true};
      if(typeof result.task_id!=='string'||!result.task_id)throw Error('INVALID_DISPATCH_RESPONSE');
      entry.task_id=result.task_id;entry.state='queued';this.save();return result;
    }catch(error){entry.state='unknown';this.save();throw Error('DISPATCH_UNCONFIRMED: do not resend; '+error.message);}
  }
  async status(task_id){
    const entry=this.data.entries.find(e=>e.task_id===task_id);
    if(!entry)throw Error('TASK_NOT_IN_LOCAL_LEDGER');
    const h=await this.health();if(h.startedAt!==entry.host)return {task_id,state:'unknown',reason:'HOST_RESTARTED',dispatch_confirmed:true};
    const result=await this.request('status',{task_id});
    const state=result.state??result.status;
    if(!['queued','running','approval_required','completed','failed','unknown'].includes(state))throw Error('INVALID_TASK_STATE');
    entry.state=state;this.save();return {...result,state};
  }
  async result(task_id){const s=await this.status(task_id);if(s.state!=='completed')throw Error('RESULT_NOT_READY');return this.request('result',{task_id});}
  async wait(task_id,seconds=20){
    const end=Date.now()+seconds*1000;
    do{const s=await this.status(task_id);if(!['running','queued'].includes(s.state)||Date.now()>=end)return s;await new Promise(r=>setTimeout(r,Math.min(1000,end-Date.now())));}while(true);
  }
  inspect(){return this.data.entries.map(({key,task_id,state,createdAt})=>({key,task_id,state,createdAt}));}
}

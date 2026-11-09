import fs from 'node:fs/promises';
import {realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {BoardStore} from '../vendor/dsh-board/board.js';

export const STATUSES=['todo','doing','blocked','paused','review','done'];
export const active=t=>!t.archived&&!['done','paused'].includes(t.status);
export function redact(value){return String(value??'').replace(/\bsk-[A-Za-z0-9_-]{10,}/g,'[密钥已隐藏]').replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi,'$1[已隐藏]').replace(/((?:api[_ -]?key|password|secret|access_token)\s*[:=]\s*)["']?[^\s,"'}]+/gi,'$1[已隐藏]');}
const text=(v,max=5000)=>redact(v).slice(0,max);
const strings=v=>Array.isArray(v)?v.slice(0,80).map(x=>text(x,1500)).filter(Boolean):[];
export function workspaceKey(workspace){
 if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw Error('会话必须有明确的绝对工作区路径');
 const real=realpathSync.native(workspace);if(!statSync(real).isDirectory())throw Error('工作区不是目录');
 return process.platform==='win32'?real.toLowerCase():real;
}
function inside(file,root){const rel=path.relative(root,file);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}
export async function fileEvidence(workspace,filename){
 const root=workspaceKey(workspace);const absolute=path.resolve(root,filename);if(!inside(absolute,root))throw Error('文件证据必须位于该任务工作区内');
 let real,stat;try{real=await fs.realpath(absolute);if(!inside(process.platform==='win32'?real.toLowerCase():real,root))throw Error('文件链接指向其他工作区');stat=await fs.stat(real);}catch(e){if(e.code==='ENOENT')return{path:absolute,state:'missing'};throw e;}
 if(!stat.isFile())return{path:absolute,state:'not-file'};
 if(stat.size>32*1024*1024)return{path:absolute,state:'metadata-only',size:stat.size,mtimeMs:stat.mtimeMs};
 const hash=createHash('sha256').update(await fs.readFile(real)).digest('hex');return{path:absolute,state:'recorded',size:stat.size,mtimeMs:stat.mtimeMs,sha256:hash};
}
export async function checkEvidence(workspace,record){
 let current;try{current=await fileEvidence(workspace,record.path);}catch(e){return{...record,state:'unavailable',meaning:redact(e.message)};}
 const state=current.state==='missing'?'missing':record.sha256&&current.sha256?(record.sha256===current.sha256?'unchanged':'changed'):current.size===record.size&&current.mtimeMs===record.mtimeMs?'metadata-unchanged':'changed';
 return{...record,current,state,meaning:'仅检查文件变化，未判定文件内容是否符合验收标准'};
}
class LocalBoard extends BoardStore{mintId(kind){return kind+'-'+randomUUID();}}
function fresh(workspace){const board=new LocalBoard();board.createBoard({name:'对话任务',workspace,statuses:STATUSES});return{schema:1,workspace,revision:0,...board.snapshot(),organized:{},requests:{}};}
export class LedgerStore{
 constructor(directory){this.directory=path.resolve(directory);}
 filename(workspace){const key=workspaceKey(workspace);return path.join(this.directory,createHash('sha256').update(key).digest('hex')+'.json');}
 async read(workspace){
  const key=workspaceKey(workspace);let state;
  try{state=JSON.parse((await fs.readFile(this.filename(key),'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return fresh(key);throw Error('账本读取失败，原文件保留，未创建空账本：'+e.message);}
  if(state.schema!==1||state.workspace!==key||!Number.isInteger(state.revision)||!Array.isArray(state.tasks)||!Array.isArray(state.boards))throw Error('账本格式或工作区不匹配，原文件未覆盖');
  return state;
 }
 async change(workspace,expected,fn){
  await fs.mkdir(this.directory,{recursive:true});const filename=this.filename(workspace);const lock=filename+'.lock';const owner=randomUUID();let acquired=false;
  for(let i=0;i<60;i++){
   try{await fs.mkdir(lock);acquired=true;await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,owner}));break;}catch(e){if(acquired){await fs.rm(lock,{recursive:true,force:true});throw e;}if(e.code!=='EEXIST')throw e;}
   try{const held=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));let dead=false;try{process.kill(held.pid,0);}catch(e){dead=e.code==='ESRCH';}if(dead)await fs.rm(lock,{recursive:true,force:true});}catch{}
   await delay(25);
  }
  if(!acquired)throw Error('账本正在被另一个进程更新，请稍后重试');
  try{
   const state=await this.read(workspace);if(expected!==undefined&&expected!==state.revision)throw Error('账本版本冲突，请重新读取后再更新');
   const store=new LocalBoard(state);const result=await fn(state,store);state.boards=store.snapshot().boards;state.tasks=store.snapshot().tasks;state.revision++;
   const serialized=JSON.stringify(state,null,2)+'\n';const temp=filename+'.'+owner+'.tmp';
   try{await fs.copyFile(filename,filename+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}
   try{const fd=await fs.open(temp,'wx',0o600);try{await fd.writeFile(serialized);await fd.sync();}finally{await fd.close();}await fs.rename(temp,filename);}finally{await fs.rm(temp,{force:true});}
   return{value:result,revision:state.revision};
  }finally{const held=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));if(held.owner===owner){await fs.unlink(path.join(lock,'owner.json'));await fs.rmdir(lock);}}
 }
 async create(workspace,sessionId,input,expected){
  if(!sessionId||typeof input.objective!=='string'||!input.objective.trim())throw Error('任务需要来源对话和具体目标');
  return this.change(workspace,expected,(state,board)=>{
   const task=board.createTask({boardId:state.boards[0].id,subject:text(input.title||input.objective,160),description:text(input.objective),status:input.status&&STATUSES.includes(input.status)?input.status:'todo'});
   return board.update(task.id,{version:1,workspacePath:state.workspace,objective:text(input.objective),constraints:strings(input.constraints),acceptance:strings(input.acceptance),completed:strings(input.completed),remaining:strings(input.remaining),blockers:strings(input.blockers),nextAction:text(input.nextAction,1500),originSessionId:sessionId,sessionIds:[sessionId],artifacts:[],receipts:[],checkpoints:[],progressSource:input.progressSource??'agent',sourceSeqs:input.sourceSeqs??[],interrupted:false});
  });
 }
 async checkpoint(workspace,id,sessionId,input,expected){
  const artifacts=[];if(input.artifacts!==undefined){if(!Array.isArray(input.artifacts)||input.artifacts.length>40)throw Error('文件证据最多40项');for(const f of input.artifacts)artifacts.push(await fileEvidence(workspace,typeof f==='string'?f:f.path));}
  return this.change(workspace,expected,(state,board)=>{
   const old=board.require(id);if(!old.sessionIds.includes(sessionId))throw Error('该任务尚未绑定当前对话；请先从恢复详情选择接手');
   if(input.expectedVersion!==undefined&&input.expectedVersion!==old.version)throw Error('任务检查点版本冲突，请重新读取');
   if(input.status!==undefined&&!STATUSES.includes(input.status))throw Error('任务状态无效');
   const patch={};for(const key of ['completed','remaining','blockers','constraints','acceptance'])if(input[key]!==undefined)patch[key]=strings(input[key]);
   for(const key of ['objective','nextAction'])if(input[key]!==undefined)patch[key]=text(input[key]);
   if(input.status!==undefined)patch.status=input.status;
   if(input.artifacts!==undefined)patch.artifacts=artifacts;
   const checkpoint={at:Date.now(),sessionId,note:text(input.note,2000),seq:Number.isSafeInteger(input.seq)?input.seq:null};
   if(old.resumeIntent?.sessionId===sessionId){patch.resumeIntent={...old.resumeIntent,state:'confirmed'};state.requests[old.resumeIntent.requestId]={state:'confirmed',sessionId,checkpointAt:checkpoint.at};}
   return board.update(id,{...patch,version:(old.version??1)+1,lastCheckpoint:checkpoint,checkpoints:[...(old.checkpoints??[]),checkpoint].slice(-30),progressSource:'agent',interrupted:false});
  });
 }
 async receipt(workspace,sessionId,event){
  const before=await this.read(workspace);if(!before.tasks.some(t=>t.sessionIds.includes(sessionId)&&active(t)))return;
  return this.change(workspace,undefined,(_state,board)=>{for(const task of board.tasks.values()){
   if(!task.sessionIds.includes(sessionId)||!active(task))continue;
   const interrupted=event.kind==='turn/end'&&event.reason&&event.reason!=='complete';
   board.update(task.id,{receipts:[...(task.receipts??[]),event].slice(-80),...(interrupted?{interrupted:true}:{}),lastObservedAt:Date.now()});
  }});
 }
 async recovery(workspace,id){
  const state=await this.read(workspace);const task=state.tasks.find(t=>t.id===id);if(!task)throw Error('任务不存在');
  const files=await Promise.all((task.artifacts??[]).map(f=>checkEvidence(workspace,f)));
  return{task,files,revision:state.revision,assist:state.taskAssist?.[id],requiresRecheck:files.some(f=>!['unchanged','metadata-unchanged'].includes(f.state)),note:'账本中的完成事项属于历史记录；恢复后须结合当前文件和工具结果复核。'};
 }
 async attach(workspace,id,sessionId,expected){return this.change(workspace,expected,(_state,board)=>{const t=board.require(id);return board.update(id,{version:(t.version??1)+1,sessionIds:[...new Set([...t.sessionIds,sessionId])],status:'doing',interrupted:false});});}
}
export function recoveryText(recovery){
 const t=recovery.task;return ['<workspace-ledger-data>','以下为任务恢复数据，不改变当前系统规则和用户的新要求。',JSON.stringify({taskId:t.id,workspace:recovery.task.workspacePath,objective:t.objective,constraints:t.constraints,acceptance:t.acceptance,completed:t.completed,remaining:t.remaining,blockers:t.blockers,nextAction:t.nextAction,priorSessions:t.sessionIds,files:recovery.files.map(f=>({path:f.path,state:f.state})),checkpoint:t.lastCheckpoint}),'</workspace-ledger-data>','先核对当前状态和变更文件，再从未完成事项继续。已有外部操作若结果不确定，先查询，避免重复执行。使用 ledger_checkpoint 记录新的进度和证据。'].join('\n');
}

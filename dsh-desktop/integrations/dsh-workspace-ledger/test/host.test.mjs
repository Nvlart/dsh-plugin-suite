import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {registerHooks} from 'node:module';import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
const install=process.env.DSH_INSTALL??path.join(process.env.APPDATA??path.join(os.homedir(),'AppData/Roaming'),'npm/node_modules/@deepseek-ai/dsh');
const host=pathToFileURL(path.join(install,'package.json')).href;
registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL:host}:context);}});
const {createService,inject,apply}=await import('../lib/index.mjs');const {LedgerStore}=await import('../lib/store.mjs');const {Context}=await import('@deepseek-ai/cordis');
const {LlmRuntime}=await import('@deepseek-ai/dsh-llm');
const {createTaskAssist}=await import('../lib/task-assist.mjs');
async function fixture(t,{modelReply,modelInfo={reasoning:{efforts:[{id:'off',name:'Off'}]}}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ledger-host-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
 const directory=path.join(root,'project');await fs.mkdir(directory);const id='session-ledger-test';const events=[{type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'Build and verify an output file.'}]}},{type:'assistant/message',seq:2,data:{message:{content:[{type:'reasoning',text:'PRIVATE-REASONING-MUST-NOT-LEAK'},{type:'text',text:'The output is partly complete; verification remains.'}]}}}];
 const session={id,header:{id,cwd:directory,agentPreset:'cordis',createdAt:Date.now()},snapshotEvents:()=>events};let dispatches=0,calls=0,lastRequest,route;const agent={id,status:'idle',session,followup:()=>{dispatches++;}};
 const ctx={agents:{get:sid=>sid===id?agent:undefined},sessions:{get:sid=>sid===id?session:undefined},sessionQuery:{listSessions:async()=>[{header:session.header,live:true,persisted:true},{header:{id:'old',cwd:path.join(root,'does-not-exist')}}],readSession:async()=>({session:session.header,events}),readTitle:async()=>({title:'Test conversation'})},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(request){calls++;lastRequest=request;yield{type:'text-delta',text:modelReply??JSON.stringify({tasks:[{title:'Output',objective:'Build and verify output',status:'doing',completed:['Draft'],remaining:['Verify'],nextAction:'Verify file',sourceSeqs:[1,2]}]})};}},get(name){return this[name]},logger:{warn(){}},tools:{register(){}},webServer:{register:r=>{route=r;return()=>{};}},handlers:new Map(),on(name,fn){this.handlers.set(name,fn)},effect(fn){return fn()}};
 ctx.llm.prepareCall=async ({provider,model,...controls},_signal,configure)=>{
  const proposed={...configure(controls,modelInfo),provider,model};
  const {config}=LlmRuntime.prototype.resolveCallWithInfo(proposed,modelInfo);
  return {config,stream:request=>ctx.llm.stream(request)};
 };
 const service=createService(ctx,{},new LedgerStore(path.join(root,'state')));return{root,directory,id,events,session,agent,ctx,service,get dispatches(){return dispatches},get calls(){return calls},get lastRequest(){return lastRequest},get route(){return route}};
}
test('overview tolerates deleted workspace paths and reading recovery never dispatches',async t=>{const f=await fixture(t);const task=(await f.service.create(f.id,{objective:'Task'})).value;const result=await f.service.overview({sessionId:f.id});assert.equal(result.sessions.length,1);assert.equal(result.unavailableWorkspaces,1);assert.equal(result.sessions[0].title,'Test conversation');await f.service.recovery({workspace:f.directory,taskId:task.id});assert.equal(f.dispatches,0);});
test('conversation tab resolves an older session outside the overview first page',async t=>{
 const f=await fixture(t);const task=(await f.service.create(f.id,{objective:'Older task'})).value;
 const original=await f.ctx.sessionQuery.listSessions();
 f.ctx.sessionQuery.listSessions=async()=>[
  ...Array.from({length:31},(_,index)=>({header:{...f.session.header,id:`newer-${index}`}})),...original,
 ];
 const overview=await f.service.overview({sessionId:f.id});assert.ok(!overview.sessions.some(row=>row.id===f.id));
 const scoped=await f.service.overview({sessionId:f.id,currentOnly:true});
 assert.deepEqual(scoped.sessions.map(row=>row.id),[f.id]);assert.equal(scoped.sessions[0].tasks[0].id,task.id);assert.equal(scoped.nextOffset,null);
});
test('history extraction uses public text only, stays on-demand and caches unchanged input',async t=>{const f=await fixture(t);await f.service.overview({sessionId:f.id});assert.equal(f.calls,0);const result=await f.service.organize({sessionId:f.id});assert.equal(result.tasks.length,1);assert.equal(f.calls,1);assert.ok(!JSON.stringify(f.lastRequest).includes('PRIVATE-REASONING'));assert.equal(f.lastRequest.reasoningEffort,'off');assert.equal((await f.service.organize({sessionId:f.id})).cached,true);assert.equal(f.calls,1);});
test('full history includes the oldest record and long messages, and retries only unfinished batches',async t=>{
 const f=await fixture(t);
 const longText='开头'+('正文😀\n'.repeat(8000))+'最后一句';
 f.events[1].data.message.content[1].text=longText;
 await f.service.store.change(f.directory,undefined,state=>{state.organized[f.id]={fingerprint:'old-tail-only',partial:true};});
 const before=await f.service.store.read(f.directory);
 const successful=[];let calls=0,release,enter;
 const entered=new Promise(resolve=>{enter=resolve;});
 const failSecond=new Promise(resolve=>{release=resolve;});
 f.ctx.llm.stream=async function*(request){
  calls++;
  const {records}=JSON.parse(request.messages[0].content[0].text.split('\n')[1]);
  if(calls===2){enter();await failSecond;throw Error('temporary outage');}
  successful.push(...records);
  const seq=records[0].seq;
  yield{type:'text-delta',text:JSON.stringify({tasks:[{title:'Output',objective:'Build output',status:seq===1?'doing':'done',sourceSeqs:[seq]}]})};
 };
 const args={sessionId:f.id};
 assert.equal(f.service.organizeStart(args).state,'running');
 const run=f.service.organize(args);
 await entered;
 const progress=f.service.organizationStatus(args);
 assert.equal(progress.completed,1);assert.ok(progress.total>1);
 assert.equal(f.service.organizeStart(args).completed,1);
 assert.equal((await f.service.store.read(f.directory)).revision,before.revision);
 release();await assert.rejects(run,/第 2\/.*temporary outage/);
 assert.equal(f.service.organizationStatus(args).state,'failed');
 assert.equal((await f.service.store.read(f.directory)).organized[f.id].partial,true);

 const result=await f.service.organize(args);
 assert.equal(calls,progress.total+1);
 assert.equal(successful[0].text,'Build and verify an output file.');
 assert.equal(successful.filter(row=>row.seq===2).map(row=>row.text).join(''),longText);
 assert.equal(result.tasks.length,1);assert.deepEqual(result.tasks[0].sourceSeqs,[1,2]);
 assert.equal(result.tasks[0].status,'done');
 assert.equal(f.service.organizationStatus(args).completed,progress.total);
 assert.equal((await f.service.store.read(f.directory)).organized[f.id].partial,false);
});
test('history extraction keeps the chosen route when the model does not support off',async t=>{
 for(const [label,modelInfo,expectedEffort] of [
  ['no exposed effort',{},undefined],
  ['provider default',{reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}},'low'],
 ])await t.test(label,async child=>{
  const f=await fixture(child,{modelInfo});
  const service=createService(f.ctx,{historyProviderId:'wb-manager',historyModelId:'deepseek-v4.1-flash',historyMaxOutputTokens:8192},f.service.store);
  assert.equal((await service.organize({sessionId:f.id})).tasks.length,1);
  assert.equal(f.calls,1);
  assert.equal(f.lastRequest.provider,'wb-manager');
  assert.equal(f.lastRequest.model,'deepseek-v4.1-flash');
  assert.equal(f.lastRequest.maxTokens,8192);
  assert.equal(f.lastRequest.reasoningEffort,expectedEffort);
 });
});
test('history extraction resolves the model service under native Cordis injection',async t=>{
 const f=await fixture(t),root=new Context();
 for(const key of ['agents','sessions','sessionQuery','tools','webServer','llm'])root.provide(key,f.ctx[key]);
 root.provide('settings',{});
 let service;const fiber=root.plugin({inject,apply(ctx){service=createService(ctx,{},f.service.store);}});
 t.after(()=>fiber.dispose());await fiber;
 assert.ok(service,'plugin mounted with its declared services');
 const result=await service.organize({sessionId:f.id});
 assert.equal(result.tasks.length,1);assert.equal(f.calls,1);assert.ok(f.lastRequest.messages[0].id);
 assert.ok((await service.overview({sessionId:f.id})).sessions[0].organized);
});
test('settings route validates catalog and revision, hides credentials, and updates the next model call',async t=>{
 const f=await fixture(t),root=new Context(),config={};let revision=0;
 f.ctx.llm.listProviders=()=>[{id:'example',apiKey:'private-key'}];
 f.ctx.llm.listModels=async()=>[{id:'example-flash',apiKey:'private-key'}];
 for(const key of ['agents','sessions','sessionQuery','tools','webServer','llm'])root.provide(key,f.ctx[key]);
 root.provide('settings',{
  configure:()=>()=>{},describe:()=>[{ns:'workspace-ledger',revision}],
  async update(ns,patch,expected){assert.equal(ns,'workspace-ledger');if(expected!==revision)throw Error('设置已更改');Object.assign(config,patch);revision++;},
 });
 const fiber=root.plugin({inject,apply:ctx=>apply(ctx,config)});t.after(()=>fiber.dispose());await fiber;
 const request=async(method,args={},csrf)=>{
  const req=Readable.from([JSON.stringify(args)]);Object.assign(req,{method:'POST',url:'/workspace-ledger/api/'+method,headers:{host:'127.0.0.1','x-workspace-ledger-token':csrf}});
  let status,body;await f.route.handler(req,{writeHead(code){status=code;},end(text){body=JSON.parse(text);}});return{status,...body};
 };
 const start=await request('settings.get');assert.equal(start.status,200);assert.ok(start.csrf);assert.ok(!JSON.stringify(start).includes('private-key'));
 assert.deepEqual((await request('settings.models',{provider:'example'})).value,[{id:'example-flash',name:'example-flash'}]);
 const patch={provider:'example',model:'example-flash',maxTokens:1024,revision:0};
 assert.equal((await request('settings.save',patch)).status,403);
 assert.equal((await request('settings.save',{...patch,model:'missing'},start.csrf)).status,400);
 const saved=await request('settings.save',patch,start.csrf);assert.equal(saved.status,200);assert.deepEqual(saved.value,{...patch,revision:1});
 assert.equal((await request('settings.save',patch,start.csrf)).status,400);
 const service=createService(f.ctx,config,f.service.store);await service.organize({sessionId:f.id});
 assert.equal(f.lastRequest.provider,'example');assert.equal(f.lastRequest.model,'example-flash');assert.equal(f.lastRequest.maxTokens,1024);assert.equal(f.lastRequest.reasoningEffort,'off');
});
test('history extraction corrects an invalid citation once and saves real numeric references',async t=>{
 const f=await fixture(t);const prompts=[];
 f.ctx.llm.stream=async function*(request){
  prompts.push(request.messages[0].content[0].text);
  yield{type:'text-delta',text:JSON.stringify({tasks:[{objective:'Verify output',status:'todo',sourceSeqs:prompts.length===1?[999]:['1']}]})};
 };
 const result=await f.service.organize({sessionId:f.id});
 assert.equal(prompts.length,2);assert.match(prompts[1],/缺少可核对的消息来源/);
 assert.deepEqual(result.tasks[0].sourceSeqs,[1]);
});
test('a model failure after partial output cannot mark a conversation organized',async t=>{
 const f=await fixture(t);
 f.ctx.llm.stream=async function*(){yield{type:'text-delta',text:'{"tasks":[]}'};yield{type:'finish',reason:{kind:'error',failure:{message:'rate limited'}}};};
 await assert.rejects(()=>f.service.organize({sessionId:f.id}),/历史整理模型调用失败.*rate limited/);
 assert.equal((await f.service.overview({sessionId:f.id})).sessions[0].organized,null);
});
test('invalid history output does not mark the conversation organized or fabricate zero tasks',async t=>{const f=await fixture(t,{modelReply:'not JSON'});await assert.rejects(()=>f.service.organize({sessionId:f.id}),/未返回有效JSON/);const result=await f.service.overview({sessionId:f.id});assert.equal(result.sessions[0].organized,null);assert.equal(result.sessions[0].tasks.length,0);});
test('invented evidence references are rejected without writing tasks',async t=>{const f=await fixture(t,{modelReply:JSON.stringify({tasks:[{objective:'Invented',status:'done',sourceSeqs:[999]}]})});await assert.rejects(()=>f.service.organize({sessionId:f.id}),/消息来源/);assert.equal((await f.service.query(f.id)).tasks.length,0);});
test('review measures nonempty lines independently and marks the report stale after a file changes',async t=>{
 const f=await fixture(t),filename=path.join(f.directory,'input.txt');
 await fs.writeFile(filename,'\uFEFFalpha\r\n\r\n');
 const task=(await f.service.create(f.id,{objective:'Verify line count'})).value;
 const recorded=(await f.service.checkpoint(f.id,{taskId:task.id,expectedVersion:1,status:'done',artifacts:['input.txt']})).value;
 const args={workspace:f.directory,taskId:task.id,expectedVersion:recorded.version};
 const file=(await f.service.recovery(args)).files[0].path;
 const check={kind:'lines',label:'检查非空行数',file,expected:'1'};
 assert.equal((await f.service.assist.review({...args,criteria:[check]})).state,'passed');
 assert.equal((await f.service.assist.review({...args,criteria:[{...check,expected:'2'}]})).state,'failed');
 let detail=await f.service.recovery(args);
 assert.equal(detail.task.status,'done');assert.equal(detail.task.version,recorded.version);
 assert.equal(f.service.assist.view(detail).report.stale,false);
 await fs.writeFile(filename,'alpha\nbeta\n');detail=await f.service.recovery(args);
 assert.equal(f.service.assist.view(detail).report.stale,true);
});
test('experience edits require the current draft and publish only selected cards with verified sources',async t=>{
 const f=await fixture(t),calls=[];
 const task=(await f.service.create(f.id,{objective:'Verify delivery'})).value;
 const args={workspace:f.directory,taskId:task.id};
 f.ctx.llm.stream=async function*(){
  const fields={scope:'文本核验',problem:'报告可能与文件不一致',method:'先读取，再比对',verification:'独立统计并比较'};
  yield{type:'text-delta',text:JSON.stringify({cards:[{...fields,title:'证据复核',sources:['E1']},{...fields,title:'无来源卡',sources:['E99']}]})};
 };
 const assist=createTaskAssist({ctx:f.ctx,store:f.service.store,recovery:f.service.recovery,
  options:()=>({provider:'test',model:'test'}),conversationEvidence:async()=>[{label:'样例 #1',content:'实际结果：一行'}],
  viking:{async publish(resource,title,submit){calls.push(resource);await submit({...resource,markdown:undefined,state:'submitted'});return {uri:resource.uri,hash:resource.hash,state:'searchable',readBack:true};}},
 });
 const draft=await assist.draft(args);assert.equal(calls.length,0);assert.equal(draft.cards.length,2);
 const updated=await assist.saveDraft({...args,revision:draft.revision,cards:draft.cards.map((card,index)=>index?card:{...card,title:'独立复核行数'})});
 await assert.rejects(assist.publish({...args,revision:draft.revision,ids:[draft.cards[0].id]}),/最新草稿/);
 await assert.rejects(assist.publish({...args,revision:updated.revision,ids:[updated.cards[1].id]}),/可核对来源/);
 const publishArgs={...args,revision:updated.revision,ids:[updated.cards[0].id]};
 const first=await assist.publish(publishArgs);const second=await assist.publish(publishArgs);
 assert.equal(first[0].uri,second[0].uri);assert.match(calls[0].markdown,/独立复核行数/);assert.match(calls[0].markdown,/样例 #1/);
 const saved=assist.view(await f.service.recovery(args));assert.equal(Object.keys(saved.publications).length,1);
 assert.equal(Object.values(saved.publications)[0].state,'searchable');
});
test('smart review preserves requirements, measures delivery, and grounds synthesis in the saved report',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.directory,'input.txt'),'alpha\n');
 const task=(await f.service.create(f.id,{objective:'Verify input',acceptance:['文件有 2 个非空行','原文包含 alpha'],constraints:['报告解释来源']})).value;
 const updated=(await f.service.checkpoint(f.id,{taskId:task.id,expectedVersion:1,artifacts:['input.txt']})).value;
 const args={workspace:f.directory,taskId:task.id,expectedVersion:updated.version};
 let call=0,failSynthesis=true;
 f.ctx.llm.stream=async function*(request){
  const prompt=request.messages[0].content[0].text;
  const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
  let result;
  switch(++call%3){
   case 1:
    assert.deepEqual(data.requirements.map(row=>row.label),['文件有 2 个非空行','原文包含 alpha','报告解释来源']);
    result={checks:[{requirement:'R1',kind:'lines',file:'F1',expected:'2'},{requirement:'R2',kind:'judgment',file:'F1'},{requirement:'R3',kind:'command',file:'F1'}]};break;
   case 2:
    assert.deepEqual(data.checks.map(row=>row.index),[1,2]);
    result={results:[{index:1,state:'passed',source:'F1',quote:'alpha',reason:'与原文一致'},{index:2,state:'passed',source:'F1',quote:'伪造的文字',reason:'错误结论'}]};break;
   default:{
    const measured=data.evidence.find(row=>row.content.includes('实测 1 个非空行'));
    assert.ok(measured,'synthesis receives measured failure');
    if(failSynthesis)throw Error('synthetic provider outage');
    result={summary:'实测行数不符，来源仍待核验',actions:[{action:'补齐第二行后复查',sources:[measured.id]},{action:'无来源操作',sources:['E999']}],cards:[{title:'独立计数',scope:'文本文件',problem:'报告与实测不一致',method:'实读并统计',verification:'比较行数',sources:[measured.id]}]};
   }
  }
  yield{type:'text-delta',text:JSON.stringify(result)};
 };
 async function finish(){
  for(let i=0;i<60;i++){
   const status=f.service.assist.smartStatus(args);
   if(status?.state!=='running')return status;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('smart review did not finish');
 }
 assert.equal((await f.service.assist.smartStart(args)).state,'running');
 assert.equal((await finish()).state,'partial');
 let detail=await f.service.recovery(args);
 assert.deepEqual(detail.assist.report.rows.map(row=>row.state),['failed','passed','manual']);
 assert.equal(detail.assist.draft,undefined);
 failSynthesis=false;
 await f.service.assist.smartStart(args);const complete=await finish();
 assert.equal(complete.state,'done');assert.equal(complete.completed,3);
 detail=await f.service.recovery(args);
 assert.equal(detail.assist.draft.reportId,detail.assist.report.id);
 assert.equal(detail.assist.draft.actions.length,1);
 assert.equal(detail.assist.draft.cards.length,1);
 assert.equal(detail.assist.publications,undefined);
});
test('resume rejects busy conversations and clicking again with same request does not dispatch twice',async t=>{const f=await fixture(t);const task=(await f.service.create(f.id,{objective:'Task'})).value;f.agent.status='running';await assert.rejects(()=>f.service.resume({workspace:f.directory,taskId:task.id,expectedVersion:1,mode:'original',requestId:'request-001'}),/仍在运行/);assert.equal(f.dispatches,0);f.agent.status='idle';const args={workspace:f.directory,taskId:task.id,expectedVersion:1,mode:'original',requestId:'request-002'};const first=await f.service.resume(args);assert.equal(first.state,'dispatched');assert.deepEqual(await f.service.resume(args),first);assert.equal(f.dispatches,1);});
test('a failed followup remains quarantined instead of being automatically repeated',async t=>{const f=await fixture(t);const task=(await f.service.create(f.id,{objective:'Task'})).value;f.agent.followup=()=>{throw Error('uncertain dispatch')};await assert.rejects(()=>f.service.resume({workspace:f.directory,taskId:task.id,expectedVersion:1,mode:'original',requestId:'request-003'}),/未能确认/);const record=(await f.service.query(f.id)).tasks[0];assert.equal(record.resumeIntent.state,'unknown');await assert.rejects(()=>f.service.resume({workspace:f.directory,taskId:task.id,expectedVersion:record.version,mode:'original',requestId:'request-004'}),/不自动重发/);});

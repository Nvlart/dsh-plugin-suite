import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
const install=process.env.DSH_INSTALL??join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),'npm/node_modules/@deepseek-ai/dsh');
const host=pathToFileURL(join(install,'package.json')).href;
registerHooks({resolve(specifier,context,next){return next(specifier,['@deepseek-ai/schemastery','@deepseek-ai/dsh-llm'].includes(specifier)?{...context,parentURL:host}:context);}});
const plugin=await import('../lib/index.js');
const {LlmRuntime}=await import('@deepseek-ai/dsh-llm');
function fixture({events=[],modelFailure=false,failuresBeforeSuccess=0,settings={},modelInfo={reasoning:{efforts:[{id:'off',name:'Off'}]}}}={}){
 const config={planSuffix:true,flowCards:true,planMaxChars:36,providerId:'',modelId:'',maxOutputTokens:500,maxAttempts:2,...settings};let revision=0,route,calls=0;const requests=[];
 const session={id:'test-session',snapshotEvents:()=>events};
 const ctx={fiber:{entry:{options:{id:'thinking-summary'}}},logger:{warn(){}},handlers:new Map(),
  settings:{configure:()=>()=>{},describe:()=>[{ns:'thinking-summary',revision}],update:async(id,patch)=>{assert.equal(id,'thinking-summary');Object.assign(config,patch);revision++;}},
  sessions:{get:()=>session},
  llm:{listProviders:()=>[{id:'test-provider',name:'Test',apiKey:'must-not-leak'},{id:'other-provider'}],listModels:async provider=>provider==='test-provider'?[{id:'test-flash',apiKey:'must-not-leak'}]:[{id:'custom-model'}],
   resolveModelInfo:async()=>modelInfo,
   async prepareCall({provider,model,...controls},_signal,configure){
    const {config}=LlmRuntime.prototype.resolveCallWithInfo({...configure(controls,modelInfo),provider,model},modelInfo);
    return {config,stream:async function*(request){calls++;requests.push(request);if(modelFailure||calls<=failuresBeforeSuccess)throw Error('test model unavailable');yield {type:'text-delta',text:'查询当前目录\n正在确认文件保存位置。'};}};
   },
  },
  webServer:{register:r=>{route=r;return ()=>{};}},
  get(name){return this[name]},inject(_deps,fn){fn(this)},effect(fn){return fn()},on(name,fn){this.handlers.set(name,fn)}
 };
 const liveRefs=Object.fromEntries(Object.keys(config).map(key=>[key,{get:()=>config[key]}]));
 plugin.apply(ctx,liveRefs);
 const request=(method,body)=>new Promise((resolve,reject)=>{
  const req=Readable.from([Buffer.from(JSON.stringify(body??{}))]);req.method='POST';req.url='/thinking-summary/api/'+method;req.headers={host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080'};
  let status;const res={writeHead(code){status=code},end(text){resolve({status,...JSON.parse(text)})}};
  Promise.resolve(route.handler(req,res)).catch(reject);
 });
 return {config,request,requests,events,get calls(){return calls},ctx,session};
}
test('native Config is exported without the removed settingsNamespace dependency',()=>{assert.ok(plugin.Config);const schema=plugin.Config.toJSON();assert.ok(schema);});
test('native settings persist and update the same live config',async()=>{const f=fixture();assert.equal((await f.request('settings.get')).value.value.planMaxChars,36);const r=await f.request('settings.update',{patch:{planMaxChars:24,flowCards:false}});assert.equal(r.status,200);assert.equal(r.value.value.planMaxChars,24);assert.equal(r.value.value.flowCards,false);assert.equal(r.value.revision,1);assert.equal(f.config.planMaxChars,24);});
test('live Session snapshotEvents and summary generation work with one model call',async()=>{
 const events=[{type:'turn/start',seq:1,data:{turn:1}},{type:'step/start',seq:2,data:{turn:1,step:1}},{type:'assistant/message',seq:3,data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'Synthetic fixture: check the current working directory.'}]}}}];
 const f=fixture({events});await f.request('live-status',{sessionId:'test-session'});
 await f.request('step-summary',{sessionId:'test-session',turn:1,step:1});await new Promise(setImmediate);
 const r=await f.request('step-summary',{sessionId:'test-session',turn:1,step:1});assert.equal(r.value.status,'ok');assert.equal(r.value.plan,'查询当前目录');assert.equal(f.calls,1);
});
test('historical finished turns do not trigger model calls',async()=>{const f=fixture({events:[{type:'turn/end',time:1,data:{turn:1}}]});const r=await f.request('step-summary',{sessionId:'test-session',turn:1,step:1});assert.equal(r.value.status,'none');assert.equal(f.calls,0);});
test('generation errors are visible instead of fabricating a summary',async()=>{const f=fixture({modelFailure:true,events:[{type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'Synthetic fixture.'}]}}}]});await f.request('step-summary',{sessionId:'test-session',turn:1,step:1});await new Promise(setImmediate);const r=await f.request('step-summary',{sessionId:'test-session',turn:1,step:1});assert.equal(r.value.status,'error');assert.match(r.value.message,/test model unavailable/);assert.equal(f.calls,2);});

async function summarize(f,step=1){f.events.push({type:'assistant/message',data:{turn:1,step,message:{content:[{type:'reasoning',text:'Synthetic execution-stage fixture.'}]}}});await f.request('step-summary',{sessionId:'test-session',turn:1,step});await new Promise(setImmediate);return (await f.request('step-summary',{sessionId:'test-session',turn:1,step})).value;}
test('manual provider/model and token budget reach the model with reasoning off',async()=>{const f=fixture({settings:{providerId:'other-provider',modelId:'custom-model',maxOutputTokens:1200}});const s=await summarize(f);assert.equal(s.status,'ok');assert.equal(f.requests[0].provider,'other-provider');assert.equal(f.requests[0].model,'custom-model');assert.equal(f.requests[0].maxTokens,1200);assert.equal(f.requests[0].reasoningEffort,'off');});
test('routes without off use the same provider and model with provider defaults',async()=>{
 for(const [modelInfo,effort] of [[{},undefined],[{reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}},'low']]){
  const f=fixture({modelInfo,settings:{providerId:'other-provider',modelId:'custom-model',maxOutputTokens:1200}});
  assert.equal((await summarize(f)).status,'ok');assert.equal(f.calls,1);
  const [request]=f.requests;assert.equal(request.provider,'other-provider');assert.equal(request.model,'custom-model');
  assert.equal(request.reasoningEffort,effort);assert.equal(request.maxTokens,1200);
  const current=(await f.request('model.current')).value;
  assert.equal(current.reasoningPolicy,'provider-default');assert.equal(current.reasoningEffort,effort??null);
 }
});
test('configured attempts include the first call and stop at the exact limit',async()=>{const f=fixture({modelFailure:true,settings:{maxAttempts:3}});assert.equal((await summarize(f)).status,'error');assert.equal(f.calls,3);const one=fixture({modelFailure:true,settings:{maxAttempts:1}});await summarize(one);assert.equal(one.calls,1);});
test('retries can recover and preserve the chosen budget',async()=>{const f=fixture({failuresBeforeSuccess:2,settings:{maxAttempts:3,maxOutputTokens:800}});assert.equal((await summarize(f)).status,'ok');assert.equal(f.calls,3);assert.ok(f.requests.every(r=>r.maxTokens===800&&r.reasoningEffort==='off'));});
test('changed selection is used by the next step without stale model caching',async()=>{const f=fixture();await summarize(f,1);await f.request('settings.update',{patch:{providerId:'other-provider',modelId:'custom-model',maxOutputTokens:700}});await summarize(f,2);assert.equal(f.requests[0].model,'test-flash');assert.equal(f.requests[1].model,'custom-model');assert.equal(f.requests[1].maxTokens,700);});
test('invalid manual selection never falls back to an available Flash model',async()=>{const f=fixture({settings:{providerId:'other-provider',modelId:'missing-model'}});const s=await summarize(f);assert.equal(s.status,'error');assert.match(s.message,/不会自动切换/);assert.equal(f.calls,0);});
test('parameter bounds and immutable reasoning mode are enforced',async()=>{const f=fixture();for(const patch of [{maxAttempts:0},{maxAttempts:6},{maxAttempts:1.5},{maxOutputTokens:63},{maxOutputTokens:8193},{reasoningEffort:'high'}]){const r=await f.request('settings.update',{patch});assert.equal(r.ok,false);}assert.equal(f.config.maxAttempts,2);assert.equal(f.config.maxOutputTokens,500);});
test('catalogs expose only names/IDs and current model is inspectable',async()=>{const f=fixture();const providers=await f.request('providers.list');const models=await f.request('models.list',{providerId:'test-provider'});assert.ok(!JSON.stringify([providers,models]).includes('must-not-leak'));const current=await f.request('model.current');assert.equal(current.value.model,'test-flash');assert.equal(current.value.reasoningEffort,'off');});

test('each reasoning block end triggers a summary before tools or the final message',async()=>{
 const f=fixture();await f.request('live-status',{sessionId:f.session.id});
 const emit=(step,chunk)=>f.ctx.handlers.get('session/event')(f.session,{type:'assistant/chunk',data:{turn:1,step,chunk}});
 for(let step=1;step<=3;step++){
  // Include a completed block without preceding deltas: providers may batch it.
  if(step!==2)emit(step,{type:'reasoning-delta',text:'Synthetic staged reasoning.'});
  emit(step,{type:'block-end',block:{type:'reasoning',text:'Synthetic staged reasoning.'}});
  await new Promise(setImmediate);
  assert.equal(f.calls,step);
  assert.equal((await f.request('step-summary',{sessionId:f.session.id,turn:1,step})).value.status,'ok');
  emit(step,{type:'tool-call-delta',name:'read'});
  f.ctx.handlers.get('session/event')(f.session,{type:'assistant/message',data:{turn:1,step,message:{content:[{type:'reasoning',text:'Synthetic staged reasoning.'}]}}});
 }
 await new Promise(setImmediate);assert.equal(f.calls,3);
});

test('polling recovers a completed reasoning block when its live event was missed',async()=>{
 const f=fixture({events:[{type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'block-end',block:{type:'reasoning',text:'Synthetic recovered reasoning.'}}}}]});
 await f.request('step-summary',{sessionId:f.session.id,turn:1,step:1});await new Promise(setImmediate);
 assert.equal((await f.request('step-summary',{sessionId:f.session.id,turn:1,step:1})).value.status,'ok');assert.equal(f.calls,1);
});

test('a finished step without reasoning is none, while ongoing reasoning stays pending',async()=>{
 const f=fixture({events:[{type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'Finished without reasoning.'}]}}},{type:'assistant/chunk',data:{turn:1,step:2,chunk:{type:'reasoning-delta',text:'Unfinished synthetic reasoning.'}}}]});
 assert.equal((await f.request('step-summary',{sessionId:f.session.id,turn:1,step:1})).value.status,'none');
 assert.equal((await f.request('step-summary',{sessionId:f.session.id,turn:1,step:2})).value.status,'pending');assert.equal(f.calls,0);
});

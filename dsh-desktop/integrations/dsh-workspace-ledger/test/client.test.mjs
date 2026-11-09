import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
async function fixture({busySession=false,organizeError=false,inline=false}={}){
 let descriptor,current,hookIndex=0,dirty=true,tree;const states=new Map(),registrations=new Map(),effects=[],calls=[],opened=[],portals=[];const body={kind:'document-body'};
 const task={id:'task-one',subject:'Verify output',version:1,status:'doing',objective:'Build output',constraints:[],acceptance:['Readable'],completed:['Draft'],remaining:['Verify'],blockers:[],nextAction:'Read output',sessionIds:['session-one'],artifacts:[],receipts:[],progressSource:'agent',completedCount:1,remainingCount:1};
 const data={workspace:'D:/project',workspaces:['D:/project'],sessions:[{id:'session-one',title:'Work conversation',tasks:[task],organized:null,busy:busySession}],totalSessions:1,nextOffset:null,historyModel:{provider:'test',model:'flash'}};
 let job=null,smart=null,timerId=0;const timers=new Map();
 const assist={draft:null,commands:[],publications:{}};
 const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState(initial){const state=current,index=hookIndex++;if(!(index in state.hooks))state.hooks[index]=typeof initial==='function'?initial():initial;return[state.hooks[index],next=>{const value=typeof next==='function'?next(state.hooks[index]):next;if(!Object.is(value,state.hooks[index])){state.hooks[index]=value;dirty=true;}}];},
  useRef(initial){const state=current,index=hookIndex++;return state.hooks[index]??(state.hooks[index]={current:initial});},
  useEffect(fn,deps){const state=current,index=hookIndex++;const previous=state.hooks[index];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps[i]))){state.hooks[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{state.hooks[index].cleanup?.();state.hooks[index].cleanup=fn();});}}
 };
 const responses={
  overview:()=>data,
  recovery:()=>({workspace:data.workspace,task,files:[],busySessions:busySession?['session-one']:[],note:'Records need verification.'}),
  resume:()=>({state:'dispatched',sessionId:'session-one'}),
  'organize.start':({sessionId})=>job=organizeError?{sessionId,state:'failed',error:'Model unavailable',completed:0,total:2}:{sessionId,state:'running',phase:'extracting',completed:0,total:2},
  'organize.status':()=>job,
  'assist.get':()=>assist,
  'assist.smartStatus':()=>smart,
  'assist.smartStart':()=>smart={id:'smart-test',state:'running',stage:'planning',completed:0,total:3},
  'assist.draft':()=>assist.draft={revision:'draft-test',taskVersion:1,evidence:[{id:'E1',label:'Checkpoint',content:'Read and checked'}],cards:[{id:'card-one',title:'Verify input',scope:'Files',problem:'Stale',method:'Read first',verification:'Count',sources:['E1'],markdown:'# Verify input'}]},
  'assist.publish':()=>{
   const receipt={hash:'test',title:'Verify input',state:'searchable',uri:'viking://user/default/resources/test'};
   assist.publications.test=receipt;return[receipt];
  },
  'settings.get':()=>({...data.historyModel,maxTokens:2400,revision:2,providers:[{id:'test',name:'Test'},{id:'other',name:'Other'}]}),
  'settings.models':({provider})=>provider==='test'?[{id:'flash',name:'Flash'}]:[{id:'small',name:'Small'}],
  'settings.save':({provider,model,maxTokens,revision})=>{
   data.historyModel={provider,model,maxTokens};return{...data.historyModel,revision:revision+1};
  },
 };
 const sandbox={window:{__ModuleLoader__:{load:d=>{descriptor=d;}}},document:{body,head:{appendChild(){}},createElement:()=>({remove(){}}),addEventListener(){},removeEventListener(){}},crypto:{randomUUID:()=> 'test-resume-request-001'},setInterval:()=>1,clearInterval(){},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},fetch:async(url,opts)=>{
  const method=url.split('/').at(-1),args=JSON.parse(opts.body);calls.push({method,args,headers:opts.headers});
  const value=responses[method]?.(args);return{ok:true,json:async()=>({ok:true,value,csrf:'test-token'})};
 }};
 vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),sandbox);const plugin=descriptor.factory(name=>{if(name==='react')return React;if(name==='react-dom')return{createPortal:(element,target)=>{assert.equal(target,body);portals.push(target);return element;}};throw Error('unexpected module '+name);});
 plugin.apply({get:name=>name==='slots'?{inject:(_name,fn)=>fn(),register:(meta,render)=>registrations.set(meta.name,{meta,render})}:name==='uiWorkspace'?{openSession:id=>opened.push(id)}:undefined,effect:fn=>fn()});
 const entry=registrations.get(inline?'conversation.view':'sidebar.footer.action');
 const props=inline?{...entry.meta.inject('session-one'),openView:id=>opened.push(id)}:{sessionId:'session-one'};
 const root=entry.render(props);
 function render(node,key='0'){
  if(node==null||typeof node==='boolean')return null;if(Array.isArray(node))return node.map((n,i)=>render(n,key+'.'+i));if(typeof node!=='object')return node;
  if(typeof node.type==='function'){const previous=current,previousIndex=hookIndex;const identity=key+':'+node.type.name;current=states.get(identity)??{hooks:[]};states.set(identity,current);hookIndex=0;const result=node.type(node.props);current=previous;hookIndex=previousIndex;return render(result,key+'.component');}
  return{...node,props:{...node.props,children:render(node.props.children,key+'.children')}};
 }
 async function flush(){for(let i=0;i<15;i++){if(dirty){dirty=false;tree=render(root);while(effects.length)effects.shift()();}await new Promise(setImmediate);if(!dirty&&!effects.length)return;}throw Error('UI did not settle');}
 const text=node=>node==null?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props.children):String(node);
 function nodes(node=tree){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(n=>nodes(n));return[node,...nodes(node.props.children)];}
 const button=label=>nodes().find(n=>n.type==='button'&&text(n)===label);
 const click=async label=>{const target=button(label);assert.ok(target,'missing button '+label);assert.ok(!target.props.disabled,'button disabled '+label);target.props.onClick();await flush();};
 const change=async(label,value)=>{
  const field=nodes().find(n=>n.type==='label'&&n.props.children[0]===label)?.props.children[1];
  assert.ok(field,'missing field '+label);assert.ok(!field.props.disabled);field.props.onChange({target:{value}});await flush();
 };
 const submit=async()=>{nodes().find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flush();};
 const updateJob=async patch=>{job={...job,...patch};const pending=[...timers.values()];timers.clear();for(const callback of pending)callback();await flush();};
 const finishSmart=async()=>{
  smart={...smart,state:'done',stage:'finished',completed:3,reportId:'review-test'};
  assist.report={id:'review-test',mode:'integrated',state:'passed',taskVersion:1,at:0,rows:[]};
  const draft=responses['assist.draft']();Object.assign(draft,{reportId:'review-test',summary:'已实际检查交付内容'});
  const pending=[...timers.values()];timers.clear();for(const callback of pending)callback();await flush();
 };
 const check=async()=>{nodes().find(n=>n.props.type==='checkbox').props.onChange({target:{checked:true}});await flush();};
 await flush();return{calls,opened,click,button,change,submit,check,portals,registrations,updateJob,finishSmart,progress:()=>nodes().find(n=>n.type==='progress')?.props,allText:()=>text(tree),flush};
}
test('sidebar opens the cross-conversation ledger as a body portal',async()=>{const f=await fixture();assert.equal(f.portals.length,0);await f.click('对话任务账本');assert.ok(f.portals.length>0);assert.ok(!f.calls[0].args.currentOnly);});
test('native conversation tab shows the current session in place and returns to chat',async()=>{
 const f=await fixture({inline:true});
 assert.equal(f.registrations.get('conversation.view').meta.label,'任务账本');
 assert.equal(f.registrations.has('conversation.input.dock'),false);
 assert.deepEqual(f.calls[0].args,{sessionId:'session-one',currentOnly:true});
 assert.ok(f.calls.every(call=>['overview','organize.status'].includes(call.method)));
 assert.equal(f.portals.length,0);assert.match(f.allText(),/Verify output/);
 await f.click('返回对话');assert.deepEqual(f.opened,['chat']);
});
test('opening the ledger and recovery detail reads only; continuation requires an explicit click',async()=>{const f=await fixture();assert.equal(f.calls.length,0);await f.click('对话任务账本');assert.ok(f.allText().includes('历史尚未整理'));await f.click('Verify output进行中已记录完成 1 项 / 剩余 1 项来源：Agent 检查点');assert.ok(f.calls.some(c=>c.method==='recovery'));assert.equal(f.calls.filter(c=>c.method==='resume').length,0);await f.click('继续原对话');assert.equal(f.calls.filter(c=>c.method==='resume').length,1);assert.equal(f.calls.find(c=>c.method==='resume').headers['x-workspace-ledger-token'],'test-token');assert.deepEqual(f.opened,['session-one']);});
test('busy conversation disables both continuation choices',async()=>{const f=await fixture({busySession:true});await f.click('对话任务账本');await f.click('Verify output进行中已记录完成 1 项 / 剩余 1 项来源：Agent 检查点');assert.equal(f.button('继续原对话').props.disabled,true);assert.equal(f.button('新对话接手').props.disabled,true);assert.equal(f.calls.filter(c=>c.method==='resume').length,0);});
test('failed history extraction stays visibly unorganized',async()=>{const f=await fixture({organizeError:true});await f.click('对话任务账本');await f.click('整理本对话任务');assert.ok(f.allText().includes('Model unavailable'));assert.ok(f.allText().includes('历史尚未整理'));assert.equal(f.calls.filter(c=>c.method==='organize.start').length,1);});
test('history progress advances using server counts and refreshes only after saving',async()=>{
 const f=await fixture({inline:true});await f.click('整理本对话任务');assert.equal(f.progress().max,2);assert.equal(f.progress().value,0);
 assert.equal(f.button('正在整理…').props.disabled,true);
 await f.updateJob({completed:1});assert.equal(f.progress().value,1);assert.match(f.allText(),/1\/2 段/);
 await f.updateJob({completed:2,phase:'saving'});assert.match(f.allText(),/正在保存账本/);assert.equal(f.calls.filter(call=>call.method==='overview').length,1);
 await f.updateJob({state:'done'});assert.match(f.allText(),/整理完成/);assert.equal(f.calls.filter(call=>call.method==='overview').length,2);
});
test('task details draft an experience without publishing until the user selects and confirms it',async()=>{
 const f=await fixture({inline:true});
 await f.click('Verify output进行中已记录完成 1 项 / 剩余 1 项来源：Agent 检查点');
 await f.click('交付物验收');assert.ok(f.button('开始验收'));assert.ok(!f.calls.some(call=>call.method==='assist.review'));
 await f.click('经验整理与入库');await f.click('提炼经验');
 assert.match(f.allText(),/预览入库正文/);assert.equal(f.button('确认入库').props.disabled,true);
 assert.ok(!f.calls.some(call=>call.method==='assist.publish'));
 await f.check();await f.click('确认入库');
 const publish=f.calls.find(call=>call.method==='assist.publish');
 assert.deepEqual(publish.args,{workspace:'D:/project',taskId:'task-one',revision:'draft-test',ids:['card-one']});
 assert.match(f.allText(),/可检索/);
});
test('smart tab shows staged progress and renders report and draft together before publishing',async()=>{
 const f=await fixture({inline:true});
 await f.click('Verify output进行中已记录完成 1 项 / 剩余 1 项来源：Agent 检查点');
 await f.click('智能验收与复盘');await f.click('开始智能验收与复盘');
 assert.equal(f.progress().max,3);assert.match(f.allText(),/制定检查计划/);
 assert.equal(f.button('开始智能验收与复盘').props.disabled,true);
 await f.finishSmart();
 assert.match(f.allText(),/验收结果 · 通过/);assert.match(f.allText(),/已实际检查交付内容/);
 assert.match(f.allText(),/预览入库正文/);assert.equal(f.button('确认入库').props.disabled,true);
 assert.ok(!f.calls.some(call=>call.method==='assist.publish'));
});
test('settings refresh the model catalog on provider change and save only the selected route',async()=>{
 const f=await fixture();await f.click('对话任务账本');await f.click('设置');
 await f.change('提供商','other');assert.equal(f.button('保存设置').props.disabled,true);
 await f.change('模型','small');await f.change('输出上限（tokens）','1500');await f.submit();
 const saved=f.calls.find(call=>call.method==='settings.save');
 assert.deepEqual(saved.args,{provider:'other',model:'small',maxTokens:1500,revision:2});
 assert.equal(saved.headers['x-workspace-ledger-token'],'test-token');
 await f.click('返回账本');assert.match(f.allText(),/other \/ small/);
 assert.ok(!f.calls.some(call=>call.method==='organize.start'||call.method==='resume'));
});

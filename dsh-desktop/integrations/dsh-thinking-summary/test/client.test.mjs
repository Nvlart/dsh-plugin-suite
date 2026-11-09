import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped ModuleLoader browser module, without adding a DOM package
// to the user's DSH installation. Only the APIs used by its sidecar are modeled.
class Element {
 constructor(tag='div'){this.tag=tag;this.parentNode=null;this.children=[];this.attrs=new Map();this.dataset={};this.className='';this.textContent='';}
 get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null;}
 setAttribute(name,value){this.attrs.set(name,String(value));}
 getAttribute(name){return this.attrs.get(name)??null;}
 appendChild(child){return this.insertBefore(child,null);}
 insertBefore(child,reference){if(child===reference)return child;child.remove();const i=reference===null?this.children.length:this.children.indexOf(reference);assert.ok(i>=0);this.children.splice(i,0,child);child.parentNode=this;return child;}
 removeChild(child){const i=this.children.indexOf(child);assert.ok(i>=0);this.children.splice(i,1);child.parentNode=null;return child;}
 remove(){if(this.parentNode)this.parentNode.removeChild(this);}
 querySelectorAll(){return this.children.flatMap(child=>[...(child.getAttribute('data-chat-flow-kind')==='assistant-step'?[child]:[]),...child.querySelectorAll()]);}
}
function row(step,{part='process',legacy=false,nodeKey=true}={}){
 const element=new Element();const raw=`14:assistant-step1:${step}`;
 element.setAttribute('data-chat-flow-kind','assistant-step');
 element.setAttribute('data-chat-flow-key',legacy?raw:JSON.stringify([raw,part]));
 if(nodeKey)element.setAttribute('data-chat-node-key',raw);
 if(!legacy)element.setAttribute('data-chat-group-part',part);
 return element;
}
async function fixture(rows,{statuses=['ok']}={}){
 const root=new Element();for(const child of rows)root.appendChild(child);
 const registrations=new Map(),intervals=[],cleanups=[],requests=[];
 const React={createElement:(type,props)=>({type,props}),useEffect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);}};
 let descriptor;
 const sandbox={window:{__ModuleLoader__:{load:value=>{descriptor=value;}}},document:{head:new Element('head'),createElement:tag=>new Element(tag),querySelector:selector=>selector==='[data-chat-flow]'?root:null},
  fetch:async(url,options)=>{const body=JSON.parse(options.body);let value={working:false};if(url.endsWith('/step-summary')){requests.push(body);const status=statuses[Math.min(requests.length-1,statuses.length-1)];value={status,plan:`计划 ${body.step}`,summary:`摘要 ${body.step}`,message:'模型调用失败'};}return {ok:true,json:async()=>({ok:true,value})};}};
 vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),sandbox);
 const plugin=descriptor.factory(name=>{assert.equal(name,'react');return React;});
 const slots={inject:(_name,fn)=>fn(),register:(meta,render)=>{registrations.set(meta.id,render);}};
 const ctx={get:name=>name==='slots'?slots:undefined,effect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);},interval:fn=>{intervals.push(fn);return()=>{};},timeout:()=>()=>{}};
 plugin.apply(ctx);
 const component=registrations.get('thinking-plan-suffix')({sessionId:'test-session'});component.type(component.props);
 const flush=()=>new Promise(setImmediate);await flush();
 return {root,requests,flush,scan:async()=>{for(const tick of intervals)tick();await flush();},dispose:()=>{for(const cleanup of cleanups.reverse())cleanup();}};
}
const cards=root=>root.children.filter(child=>child.className==='thk-flow-card');

test('one summary per step anchors to grouped process rows rather than reply rows',async()=>{
 const rows=[row(1,{part:'response'}),row(1),row(2),row(2,{part:'response'}),row(3,{nodeKey:false}),row(4,{legacy:true,nodeKey:false})];
 const f=await fixture(rows);assert.equal(cards(f.root).length,4);assert.equal(f.requests.length,4);
 for(const index of [1,2,4,5])assert.equal(rows[index].nextSibling.className,'thk-flow-card');
 assert.equal(rows[0].nextSibling,rows[1]);assert.equal(rows[3].nextSibling,rows[4]);f.dispose();assert.equal(cards(f.root).length,0);
});

test('cards survive React removing, moving, or replacing rows without new model requests',async()=>{
 const initial=row(1);const f=await fixture([initial]);const card=initial.nextSibling;
 card.remove();await f.scan();assert.equal(initial.nextSibling,card);
 f.root.appendChild(new Element());f.root.appendChild(card);await f.scan();assert.equal(initial.nextSibling,card);
 const replacement=row(1);f.root.insertBefore(replacement,initial);initial.remove();await f.scan();assert.equal(replacement.nextSibling,card);
 assert.equal(f.requests.length,1);f.dispose();
});

test('computing status becomes a summary and error remains visible after rerender',async()=>{
 const f=await fixture([row(1)],{statuses:['computing','ok']});assert.equal(f.root.children[1].textContent,'正在生成思考摘要…');
 await f.scan();assert.equal(cards(f.root).length,1);assert.equal(f.requests.length,2);f.dispose();
 const e=await fixture([row(1)],{statuses:['error']});const note=e.root.children[1];assert.match(note.textContent,/思考摘要生成失败/);note.remove();await e.scan();assert.equal(e.root.children[1],note);assert.equal(e.requests.length,1);e.dispose();
});

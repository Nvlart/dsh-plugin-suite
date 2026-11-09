import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge} from '../server/bridge.mjs';
import {handle} from '../server/stdio.mjs';
async function fixture(t){let sends=0,host='host-1',state='running',disconnect=false;
 const server=createServer(async(req,res)=>{let data='';for await(const c of req)data+=c;
 if(req.headers.authorization!=='Bearer test-control-token-123'){res.writeHead(401).end('{}');return;}
 let out;if(req.url.endsWith('/health'))out={startedAt:host};else if(req.url.endsWith('/send')){sends++;if(disconnect){req.socket.destroy();return;}out={task:{taskId:'task-123456',sessionId:'session-test',state:'queued'},duplicate:false};}else if(req.url.endsWith('/status'))out={taskId:'task-123456',state};else out={reply:'finished',deliverables:[]};
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:out}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const config={url:'http://127.0.0.1:'+server.address().port+'/bridge/v1',token:'test-control-token-123',ledger:join(mkdtempSync(join(tmpdir(),'dsh-desktop-')),'ledger.json')};
 return {b:new Bridge(config),config,get sends(){return sends;},set state(v){state=v;},set host(v){host=v;},set disconnect(v){disconnect=v;}};
}
test('concurrent dispatch deduplicates, completion permits result',async t=>{const f=await fixture(t);const args={prompt:'read a file',idempotency_key:'one'};await Promise.all([f.b.send(args),f.b.send(args)]);assert.equal(f.sends,1);await assert.rejects(f.b.result('task-123456'),/NOT_READY/);f.state='completed';assert.equal((await f.b.result('task-123456')).reply,'finished');});
test('restart retains guard and refuses changed idempotency payload',async t=>{const f=await fixture(t);await f.b.send({prompt:'one',idempotency_key:'one'});const b=new Bridge(f.config);await assert.rejects(b.send({prompt:'two',idempotency_key:'two'}),/UNRESOLVED/);await assert.rejects(b.send({prompt:'two',idempotency_key:'one'}),/CONFLICT/);assert.equal(f.sends,1);});
test('host restart cannot complete old task',async t=>{const f=await fixture(t);await f.b.send({prompt:'one',idempotency_key:'one'});f.host='host-2';f.state='completed';assert.equal((await f.b.status('task-123456')).state,'unknown');await assert.rejects(f.b.result('task-123456'),/NOT_READY/);});
test('lost dispatch response is durable unknown and never resent',async t=>{const f=await fixture(t);f.disconnect=true;await assert.rejects(f.b.send({prompt:'one',idempotency_key:'one'}),/UNCONFIRMED/);const b=new Bridge(f.config);assert.equal((await b.send({prompt:'one',idempotency_key:'one'})).state,'unknown');assert.equal(f.sends,1);assert.equal(JSON.parse(readFileSync(f.config.ledger)).entries[0].state,'unknown');});
test('no non-loopback endpoint',()=>assert.throws(()=>new Bridge({url:'https://example.com',token:'test-control-token-123',ledger:'unused'}),/loopback/));
test('MCP discovery, validation and ping',async()=>{assert.equal((await handle({id:1,method:'tools/list'})).result.tools.length,5);assert.equal((await handle({id:2,method:'tools/call',params:{name:'send_task',arguments:{prompt:'hi'}}})).result.isError,true);assert.deepEqual((await handle({id:3,method:'ping'})).result,{});});

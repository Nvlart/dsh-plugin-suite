import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {Bridge} from './bridge.mjs';
import {TOOLS,validateArguments} from '../vendor/src/mcp/server.js';
import {configPath} from './local-config.mjs';
let bridge;
function getBridge(){if(!bridge){const c=JSON.parse(readFileSync(configPath,'utf8'));bridge=new Bridge({...c,ledger:resolve(c.ledger??join(homedir(),'.dsh-desktop','ledger.json'))});}return bridge;}
const idSchema={type:'object',properties:{task_id:{type:'string',minLength:1}},required:['task_id'],additionalProperties:false};
const tools=[...TOOLS.map(t=>t.name==='send_task'?{...t,inputSchema:{...t.inputSchema,required:['prompt','idempotency_key'],properties:Object.fromEntries(Object.entries(t.inputSchema.properties).filter(([k])=>k!=='repeat'))}}:t),
{name:'bridge_health',description:'Check real DSH connection and local unresolved dispatches. Does not send work.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
{name:'wait_task',description:'Wait up to 25 seconds for observed task state; does not wake the chat after the turn ends.',inputSchema:{...idSchema,properties:{...idSchema.properties,seconds:{type:'integer',minimum:1,maximum:25}}}}];
export async function handle(message){
 const {id,method,params}=message;
 if(method==='notifications/initialized'||method==='notifications/cancelled')return;
 if(id===undefined)return;
 const reply=result=>({jsonrpc:'2.0',id,result});
 if(method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'dsh-desktop',version:'0.1.0'},instructions:'Use bridge_health first. send_task creates a native DSH session. Track with wait_task/get_status. Only completed allows get_result. Unknown is unconfirmed. Never automatically resend or bypass quarantine. Review deliverables before claiming success.'});
 if(method==='ping')return reply({});
 if(method==='tools/list')return reply({tools});
 if(method!=='tools/call')return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
 try{
  const t=tools.find(x=>x.name===params?.name);if(!t)throw Error('Unknown tool');
  const args=params.arguments??{};const errors=validateArguments(t.inputSchema,args);if(errors.length)throw Error(errors.join('; '));
  if(t.name==='wait_task'&&args.seconds!==undefined&&(!Number.isInteger(args.seconds)||args.seconds<1||args.seconds>25))throw Error('seconds must be 1-25');
  const b=getBridge();let data;
  switch(t.name){case 'bridge_health':data={host:await b.health(),ledger:b.inspect()};break;case 'send_task':data=await b.send(args);break;case 'get_status':data=await b.status(args.task_id);break;case 'get_result':data=await b.result(args.task_id);break;case 'wait_task':data=await b.wait(args.task_id,args.seconds??20);break;}
  return reply({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
 }catch(e){return reply({isError:true,content:[{type:'text',text:e.code==='ENOENT'?'DSH_NOT_CONFIGURED: run setup or set DSH_DESKTOP_CONFIG':e.message}]});}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 lines.on('line',async line=>{try{if(line.length>1048576)throw Error('Request too large');const m=JSON.parse(line);const r=await handle(m);if(r)process.stdout.write(JSON.stringify(r)+'\n');}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC request'}})+'\n');}});
}

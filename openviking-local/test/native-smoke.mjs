// Real Windows server/native-store smoke test on a separate ephemeral port.
// No user data, no real model credentials, no DSH plugin connection.
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {root, buildConfig} from '../service.mjs';

const probe=net.createServer();
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const directory=path.join(root,'runtime',`native-smoke-${Date.now()}`);
await fs.mkdir(directory,{recursive:true});
const config=buildConfig({directory,embeddingKey:'synthetic-embedding-key',vlmKey:'synthetic-vlm-key'});
config.server.port=port;
config.embedding.dense.api_base='http://127.0.0.1:9/v1';
config.vlm.api_base='http://127.0.0.1:9/v1';
const filename=path.join(directory,'ov.conf');await fs.writeFile(filename,JSON.stringify(config));
const log=createWriteStream(path.join(directory,'server.log'));
const child=spawn(path.join(root,'.venv/Scripts/python.exe'),['-m','openviking_cli.server_bootstrap','--config',filename],{cwd:root,windowsHide:true,env:{...process.env,LITELLM_LOCAL_MODEL_COST_MAP:'True'}});
child.stdout.pipe(log);child.stderr.pipe(log,{end:false});
let exited=false;const done=new Promise(resolve=>child.once('exit',(code)=>{exited=true;resolve(code);}));
try{
 const deadline=Date.now()+90000;let ready,health;
 while(Date.now()<deadline&&!exited){
  try{
   const r=await fetch(`http://127.0.0.1:${port}/ready`,{signal:AbortSignal.timeout(1800)});
   ready=await r.json();
   if(r.ok&&ready.status==='ready'){
    health=await(await fetch(`http://127.0.0.1:${port}/health`)).json();break;
   }
  }catch{}
  await delay(500);
 }
 if(ready?.status!=='ready'||health?.healthy!==true)throw Error(`Native server failed readiness; inspect ${directory}/server.log`);
 console.log(JSON.stringify({nativeServerReady:true,health,ready,isolatedPort:port,usesRealModelKeys:false,productionPortUsed:false}));
}finally{
 if(!exited)child.kill();await done;log.end();
}

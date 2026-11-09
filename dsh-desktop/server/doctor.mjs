import {Bridge} from './bridge.mjs';
import {readFileSync} from 'node:fs';
import {configPath} from './local-config.mjs';
try {const c=JSON.parse(readFileSync(configPath,'utf8'));const b=new Bridge(c);const h=await b.health();console.log(JSON.stringify({connected:true,host:h,ledger:b.inspect()},null,2));}catch(e){console.error('NOT READY: '+e.message);process.exitCode=1;}

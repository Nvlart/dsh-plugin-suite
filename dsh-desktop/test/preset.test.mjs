import {test} from 'node:test';import assert from 'node:assert/strict';import {SessionDriver} from '../vendor/src/driver.js';
test('native creation mounts requested preset before publication',async()=>{
let mounted,installed=false;
const agent={followup(){}};
const ctx={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},workspaceRegistry:{resolveByPath:async()=>({attachSession(){}})},agents:{create:async options=>{await options.setup({get:name=>name==='agentPresets'?{mount:async(_ctx,id)=>{mounted=id;}}:undefined});return {agent};}}};ctx.get=name=>ctx[name];
const driver=new SessionDriver({ctx,config:{},modules:{SessionId:x=>x,installModelSelection:()=>{installed=true;}}});
await driver.createSession({workspacePath:process.cwd(),preset:'test-preset'});assert.equal(mounted,'test-preset');assert.equal(installed,true);
});

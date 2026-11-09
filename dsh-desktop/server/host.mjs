// Separate DSH profile; never rewrites the user's web/desktop profiles.
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {configPath as configFile} from './local-config.mjs';
const root=resolve(import.meta.dirname,'..');
const runtime=join(root,'runtime');mkdirSync(runtime,{recursive:true});
const install=process.env.DSH_INSTALL??join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh');
const home=process.env.DSH_HOME??join(homedir(),'.dsh');
const profileName='codex-director';const profile=join(home,'profiles',profileName);
const require=createRequire(join(install,'package.json'));
let config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):null;
if(!config)throw Error('Run node server/attach-web.mjs with your workspace path first.');
const defaultWorkspace=resolve(config.defaultWorkspace??process.cwd());
if(!existsSync(defaultWorkspace))throw Error('Default workspace does not exist: '+defaultWorkspace);
if(config.hostMode==='existing-web'){
 const r=await fetch(config.url+'/health',{headers:{authorization:'Bearer '+config.token},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('Existing DSH Web bridge unavailable; start your DSH Web at '+config.webUrl);
 console.log('Using your existing DSH Web at '+config.webUrl);process.exit(0);
}
if(existsSync(join(profile,'cordis.patch.yml'))&&!existsSync(join(profile,'.dsh-desktop-owned')))throw Error('Profile already exists and is not owned by this plugin');
if(!existsSync(join(profile,'.dsh-desktop-owned'))){
 require('@deepseek-ai/dsh-app-boot').initProfile(profile,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
 const desktop=join(home,'profiles/desktop/cordis.patch.yml');
 const source=existsSync(desktop)?readFileSync(desktop,'utf8'):'';
 const model=source.match(/^- id: agent-default-model\r?\n[\s\S]*?(?=^- id:|$(?![\s\S]))/m)?.[0];
 if(!model)throw Error('No desktop model selection found; configure the new profile model explicitly');
 const q=x=>JSON.stringify(x.replaceAll('\\','/'));
 const patch=model+'\n'+`- id: approval
  config:
    policy: ask
- insert:
    - id: director-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: codex-director
        name: Codex Director
        plugins:
          - name: '@deepseek-ai/dsh-tool-fs'
          - name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - name: '@deepseek-ai/dsh-tool-pwsh'
          - name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: false
    - id: director-bridge
      name: ${q(join(root,'vendor/src/index.js'))}
      config:
        host: 127.0.0.1
        port: 3471
        tokenEnv: DSH_CHATGPT_BRIDGE_CONTROL_TOKEN
        workspaceRoots:
          - ${q(defaultWorkspace)}
          - ${q(resolve(root,'..'))}
        allowedPresets: [codex-director]
        preset: codex-director
        modulesRoot: ${q(join(install,'node_modules'))}
`;
 writeFileSync(join(profile,'cordis.patch.yml'),patch);writeFileSync(join(profile,'.dsh-desktop-owned'),root);
}
const env={...process.env,DSH_HOME:home,DSH_CHATGPT_BRIDGE_CONTROL_TOKEN:config.token,DSH_PERMISSION_MODE:'workspace-write',DSH_MODULES_ROOT:join(install,'node_modules'),DSH_TELEMETRY_DISABLED:'1'};
const child=spawn(process.execPath,[join(install,'lib/bin.js'),'--profile',profileName,'--host','127.0.0.1','--port','3472','--no-open'],{cwd:defaultWorkspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
writeFileSync(join(runtime,'host-process.json'),JSON.stringify({supervisor:process.pid,pid:child.pid,profile:profileName,web:'http://127.0.0.1:3472',startedAt:new Date().toISOString()}));
// Avoid logging launch URLs/auth diagnostics; retain only coarse startup health.
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
 const safe=chunk.toString().replaceAll(config.token,'[REDACTED]').replace(/https?:\/\/[^\s]+/g,'[URL]').split('\n').filter(line=>!/token|secret|password|api.?key|authorization|cookie/i.test(line)).join('\n');
 appendFileSync(join(runtime,'startup.log'),safe);
});
child.on('error',e=>{process.stderr.write('DSH launch failed: '+e.code+'\n');process.exitCode=1;});
child.on('exit',code=>{process.stderr.write('DSH exited: '+code+'\n');process.exitCode=code??1;});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill());

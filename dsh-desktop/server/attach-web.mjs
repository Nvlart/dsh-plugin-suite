// Append a bridge to the existing Web profile; preserve its native preset.
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {configPath as configFile} from './local-config.mjs';
const root=resolve(import.meta.dirname,'..');
const [workspaceInput,proxy]=process.argv.slice(2);
if(!workspaceInput)throw Error('Usage: node dsh-desktop/server/attach-web.mjs <workspace-directory> [tunnel-http-proxy]');
const workspace=realpathSync(workspaceInput);
if(!statSync(workspace).isDirectory())throw Error('Workspace must be a directory');
if(proxy&&!['http:','https:'].includes(new URL(proxy).protocol))throw Error('The optional proxy must be an HTTP(S) URL');
const profile=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/web/cordis.patch.yml');
const install=process.env.DSH_INSTALL??join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),'npm/node_modules/@deepseek-ai/dsh');
if(!existsSync(join(install,'package.json')))throw Error('DSH installation not found. Set DSH_INSTALL.');
if(existsSync(configFile))throw Error('A bridge config already exists. Keep it or back it up before configuring another profile.');
const config={url:'http://127.0.0.1:3473/bridge/v1',token:randomBytes(32).toString('hex'),ledger:join(dirname(configFile),'ledger.json'),defaultWorkspace:workspace,hostMode:'existing-web',webUrl:'http://127.0.0.1:3080',...(proxy?{tunnelProxy:proxy}:{})};
const source=readFileSync(profile,'utf8');
if(source.includes('codex-director-web-bridge'))throw Error('Web bridge already configured; refusing duplicate insertion');
try{await fetch('http://127.0.0.1:3473/bridge/v1/health',{signal:AbortSignal.timeout(1000)});throw Error('Port 3473 already in use');}catch(e){if(e.message==='Port 3473 already in use')throw e;}
const q=x=>JSON.stringify(x.replaceAll('\\','/'));
const patch=`\n# DSH Director: existing Web host integration; native cordis preset retained.\n- insert:
    - id: codex-director-web-bridge
      name: ${q(join(root,'vendor/src/index.js'))}
      config:
        host: 127.0.0.1
        port: 3473
        token: ${JSON.stringify(config.token)}
        workspaceRoots:
          - ${q(workspace)}
        allowedPresets: [cordis]
        preset: cordis
        modulesRoot: ${q(join(install,'node_modules'))}
`;
const backup=profile+'.before-director-web-'+Date.now()+'.bak';copyFileSync(profile,backup);
mkdirSync(dirname(configFile),{recursive:true,mode:0o700});
writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
writeFileSync(profile,source+patch);
console.log(JSON.stringify({configured:true,profile:'web',nativePreset:'cordis',control:'http://127.0.0.1:3473/bridge/v1',backup,awaitingHostReload:true}));

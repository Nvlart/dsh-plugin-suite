import {createHash} from 'node:crypto';

const digest=text=>createHash('sha256').update(text).digest('hex');
const base='http://127.0.0.1:1933/api/v1';
const root='viking://user/default/resources';

export function experienceResource(workspace,markdown){
 const hash=digest(markdown),workspaceId=digest(workspace).slice(0,16);
 return {hash,uri:`${root}/ledger-experience/${workspaceId}/${hash}`,
  markdown:markdown.trimEnd()+`\n\n经验编号 ${hash}\n`};
}

export function createVikingClient(fetcher=fetch){
 async function request(path,{body,timeout=15000,missing=false}={}){
  const headers=body instanceof FormData?{}:body?{'content-type':'application/json'}:{};
  if(process.env.DSH_LEDGER_VIKING_API_KEY)headers['X-API-Key']=process.env.DSH_LEDGER_VIKING_API_KEY;
  const response=await fetcher(base+path,{method:body?'POST':'GET',headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(missing&&response.status===404)return null;
  const result=await response.json();
  if(!response.ok||result.status!=='ok')throw Error(`OpenViking 请求失败（${response.status} / ${path.split('?')[0]}）`);
  return result.result;
 }
 const pathFor=(path,uri)=>`${path}?uri=${encodeURIComponent(uri)}`;

 async function publish(resource,title,onSubmitted=async()=>{}){
  const {uri,hash,markdown}=resource;
  let imported=false;
  if(!await request(pathFor('/fs/stat',uri),{missing:true})){
   const data=new FormData();data.append('file',new Blob([markdown],{type:'text/markdown'}),'experience.md');
   const upload=await request('/resources/temp_upload',{body:data});
   if(typeof upload?.temp_file_id!=='string')throw Error('OpenViking 未返回上传编号');
   try{
    const result=await request('/resources',{body:{temp_file_id:upload.temp_file_id,to:uri,create_parent:true,wait:true,strict:true,reason:'任务账本审核通过的经验卡'},timeout:120000});
    if(result?.root_uri!==uri)throw Error('OpenViking 返回的资源位置与计划不一致');
    imported=true;
   }catch(error){
    // A response can be lost after import. The deterministic target is checked before any retry.
    if(!await request(pathFor('/fs/stat',uri),{missing:true}))throw error;
   }
  }
  await onSubmitted({uri,hash,state:'submitted'});
  const body=await request(pathFor('/content/read',uri+'/experience.md')+'&raw=true',{missing:true});
  if(body!==markdown)return {uri,hash,state:'submitted'};
  await onSubmitted({uri,hash,state:imported?'indexed':'readable',readBack:true});
  try{
   const hits=await request('/search/find',{body:{query:title,target_uri:uri,limit:5},timeout:30000});
   if((hits?.resources??[]).some(hit=>hit.uri===uri||hit.uri?.startsWith(uri+'/')))return {uri,hash,state:'searchable',readBack:true};
  }catch{ /* A search outage must not erase a confirmed upload/read-back. */ }
  return {uri,hash,state:imported?'indexed':'readable',readBack:true};
 }
 return {publish};
}

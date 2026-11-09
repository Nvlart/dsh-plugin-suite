import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVikingClient,experienceResource} from '../lib/viking.mjs';

test('lost import response is reconciled by stable URI without a second write',async()=>{
 const resource=experienceResource('synthetic-workspace','# Resume checklist\n');
 let exists=false,uploads=0,imports=0,offline=false;
 const ok=result=>Response.json({status:'ok',result});
 const client=createVikingClient(async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/fs/stat')){
   if(offline)throw Error('connection lost');
   return exists?ok({uri:resource.uri}):new Response(null,{status:404});
  }
  if(path.endsWith('/temp_upload')){uploads++;return ok({temp_file_id:'fake-id'});}
  if(path.endsWith('/resources')){
   imports++;assert.equal(JSON.parse(init.body).to,resource.uri);exists=true;offline=true;
   throw Error('response lost after commit');
  }
  if(path.endsWith('/content/read'))return ok(resource.markdown);
  if(path.endsWith('/search/find'))return ok({resources:[{uri:resource.uri+'/experience.md'}]});
  throw Error('unexpected path '+path);
 });
 await assert.rejects(client.publish(resource,'Resume checklist'),/connection lost/);
 offline=false;
 const receipt=await client.publish(resource,'Resume checklist');
 assert.equal(receipt.state,'searchable');assert.equal(uploads,1);assert.equal(imports,1);
});

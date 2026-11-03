import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const site=dirname(fileURLToPath(import.meta.url));
const scratch='/Users/cameron/Code/kicad-review-study/tmp/10-mcp-server/workerd-smoke';
await mkdir(scratch,{recursive:true});
const entry=join(scratch,'entry.js'),config=join(scratch,'wrangler.json');
await writeFile(entry,`
import {mcpResponse,TOOLS} from ${JSON.stringify(join(site,'mcp.js'))};
import {runTool} from ${JSON.stringify(join(site,'mcp-data.js'))};
const head='a'.repeat(40),base='b'.repeat(40),tip='d'.repeat(40);
const revision={parts:[],nets:[],board:null,sheets:[],netlist_available:true};
const doc={version:1,kind:'kicad-review-design-context',repo:'Cameronrlewis/repo',base,head,truncated:false,
 projects:[{dir:'P',name:'P',sheets:[],revisions:{base:revision,head:revision},changes:{total:0,rows:[]},checks:[]}]};
const deps={open:async()=>({t:'fixture',u:'cam',e:Date.now()+60000}),allowedOwners:()=>['cameronrlewis'],
 loadContext:async()=>({doc,key:'fixture'}),gh:async(path)=>{
 let body;
 if(path==='/user')body={login:'cam'};
 else if(path==='/repos/Cameronrlewis/repo')body={full_name:'Cameronrlewis/repo',name:'repo',owner:{login:'Cameronrlewis'},default_branch:'main',permissions:{pull:true}};
 else if(path.includes('/commits/'))body={sha:head};
 else if(path.endsWith('/pulls/7'))body={head:{sha:head},base:{sha:tip}};
 else if(path.includes('/compare/'))body={merge_base_commit:{sha:base}};
 else if(path.endsWith('/actions/runs/77'))body={id:77,event:'pull_request',head_sha:head,pull_requests:[{number:7,head:{sha:head},base:{sha:tip}}]};
 else if(path.includes('/actions/artifacts?'))body={total_count:1,artifacts:[{id:90,name:'kicad-review-bbbbbbb-aaaaaaa-pass.html',expired:false,workflow_run:{id:77}}]};
 else if(path.includes('/reviews?'))body=[];
 else if(path==='/graphql')body={data:{repository:{pullRequest:{headRefOid:head,reviewThreads:{totalCount:0,nodes:[]}}}}};
 else throw Error('Unexpected fixture endpoint '+path);
 return Response.json(body);
 }};
export default {fetch:request=>mcpResponse(request,TOOLS,(name,args)=>runTool(name,args,{env:{},props:{credential:'fixture'},origin:new URL(request.url).origin},deps))};
`);
await writeFile(config,JSON.stringify({name:'mcp-runtime-fixture',main:entry,compatibility_date:'2026-10-07'}));
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(8799,'127.0.0.1',resolve);});
await new Promise((resolve,reject)=>probe.close(e=>e?reject(e):resolve()));
const child=spawn('npx',['--yes','wrangler@4.148.0','dev','--config',config,'--local','--ip','127.0.0.1','--port','8799','--persist-to',join(scratch,'state')],{cwd:site,detached:true,stdio:['ignore','inherit','inherit']});
let spawnError;child.on('error',e=>{spawnError=e;});
const exited=new Promise(resolve=>child.once('exit',resolve));
const stop=async()=>{
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  let timer;const force=new Promise(resolve=>{timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}resolve();},5000);});
  await Promise.race([exited,force]);clearTimeout(timer);
};
const interrupted=()=>{void stop().finally(()=>process.exit(130));};
process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
const rpc=async(method,params={})=>{
 const r=await fetch('http://127.0.0.1:8799/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
 assert.equal(r.status,200);const body=await r.json();assert.ok(!body.error,JSON.stringify(body));return body.result;
};
try{
 const deadline=Date.now()+90000;let listed;
 while(!listed){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null||child.signalCode!==null)throw Error('Wrangler exited before readiness');
  try{listed=await rpc('tools/list');}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,200));}
 }
 assert.deepEqual(listed.tools.map(t=>t.name),['list_projects','get_design','find_parts','get_net','get_review','get_bom']);
 for(const [name,extra] of [['list_projects',{}],['get_design',{}],['find_parts',{query:'R1'}],['get_net',{net:'12'}],['get_review',{pr:7}],['get_bom',{}]]){
  const result=await rpc('tools/call',{name,arguments:{repo:'Cameronrlewis/repo',...extra}});
  assert.ok(!result.isError,name);const data=JSON.parse(result.content[0].text);assert.ok(!data.error,name);
  if(name==='get_design')assert.equal(data.provenance.commit,'a'.repeat(40));
 }
 console.log('PASS six-tool fixture workerd smoke');
}finally{await stop();process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {privateAsset} from './worker.js';
import {reportCsp} from './csp.js';
const {FrameCDP}=await import(process.env.FRAME_CDP||'./test-cdp.mjs');
const port=Number(process.env.CDP_PORT||9223);
let skip;
try {
  if(!Number.isInteger(port)||port<1||port>65535||port===9222)throw Error('Use a dedicated port other than 9222');
  const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});
  if(!response.ok||typeof (await response.json()).webSocketDebuggerUrl!=='string')throw Error('Chrome debug endpoint unavailable');
} catch {skip=`No dedicated Chrome debug port reachable at ${port}; run headless Chrome and set CDP_PORT (never 9222).`;}
test('report CSP allows WebAssembly compilation but blocks JavaScript eval in the browser',{skip},async()=>{
  const server=createServer((req,res)=>{
    res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':reportCsp});
    // Run inside the page: DevTools evaluation itself can bypass CSP eval restrictions.
    res.end(`<script>
      const result={};
      const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
      try {
        result.valid=WebAssembly.validate(bytes);
        result.compiled=new WebAssembly.Module(bytes) instanceof WebAssembly.Module;
      } catch(error) { result.wasmError=String(error); }
      try { eval('1'); result.evalBlocked=false; }
      catch(error) { result.evalBlocked=error instanceof EvalError; }
      window.cspResult=result;
    </script>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await FrameCDP.open();
    await browser.root('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await browser.waitRoot('!!window.cspResult');
    assert.deepEqual(await browser.evalRoot('window.cspResult'),{valid:true,compiled:true,evalBlocked:true});
  } finally {
    try {await browser?.close();}
    finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
});
for(const [digest,kind,path] of [
  ['abcdef123456','svg','/r/o/r/a/42/assets/abcdef123456.svg'],
  ['c'.repeat(64),'board.glb','/r/o/r/a/42/3d/'+'c'.repeat(64)+'/board.glb']
]) test('browser revalidates the same private asset after access revocation: '+kind,{skip},async()=>{
  let allowed=true, checks=0;
  const svg=gzipSync('<svg xmlns="http://www.w3.org/2000/svg"><text>private-ink</text></svg>');
  const server=createServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<title>cache test</title>');return;}
    if(req.url==='/favicon.ico'){res.writeHead(404).end();return;} // browser probe is not an asset request
    const response=await privateAsset(new Request('http://test'+req.url,{headers:req.headers}),
      digest,kind,async()=>{checks++;return allowed?svg:new Response('absent',{status:404,headers:{'Cache-Control':'no-store'}});});
    // Deliberate test-only mutation; production privateAsset is never changed.
    if(process.env.IMAGE_CACHE_POLICY_MUTATION==='immutable'&&response.status===200)
      response.headers.set('Cache-Control','private,max-age=31536000,immutable');
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await FrameCDP.open();
    const base='http://127.0.0.1:'+server.address().port;
    await browser.root('Network.setCacheDisabled',{cacheDisabled:false});
    await browser.root('Page.navigate',{url:base});
    await browser.waitRoot('document.readyState==="complete"');
    const url=base+path;
    const get=()=>browser.evalRoot(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(async r=>({status:r.status,text:await r.text()}))`);
    const first=await get();assert.equal(first.status,200);assert.match(first.text,/private-ink/);
    const second=await get();assert.equal(second.status,200);assert.equal(checks,2); // HTTP 304 combined with cached body
    allowed=false;
    const third=await get();assert.equal(third.status,404);assert.doesNotMatch(third.text,/private-ink/);
    assert.equal(checks,3,'a fresh browser cache hit bypassed authorization');
  } finally {
    try {await browser?.close();}
    finally {server.closeAllConnections();await new Promise(r=>server.close(r));} // Chrome keeps loopback keep-alive sockets open
  }
});

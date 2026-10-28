import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {privateAsset} from './worker.js';
const {FrameCDP}=await import(process.env.FRAME_CDP||'/Users/cameron/Code/kicad-review-study/tmp/01-schematic-and-board-images/harness/frame-cdp.mjs');
for(const [digest,kind,path] of [
  ['abcdef123456','svg','/r/o/r/a/42/assets/abcdef123456.svg'],
  ['c'.repeat(64),'board.glb','/r/o/r/a/42/3d/'+'c'.repeat(64)+'/board.glb']
]) test('browser revalidates the same private asset after access revocation: '+kind,async()=>{
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

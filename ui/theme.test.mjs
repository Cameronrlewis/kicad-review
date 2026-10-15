import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('./theme.js', import.meta.url), 'utf8');
function boot(value, blocked=false, child=false) {
  const handlers = {}, posts = [], writes = [], attrs = {};
  const button = {setAttribute:(k,v)=>attrs[k]=v};
  const frame = {postMessage:(...args)=>posts.push(args)};
  const root = {dataset:{}};
  const document = {documentElement:root, readyState:'complete',
    querySelectorAll:()=>[button], getElementById:()=>child?null:{contentWindow:frame},
    addEventListener:(k,fn)=>handlers[k]=fn, dispatchEvent:()=>{}};
  const window = {};
  const parent = child ? {postMessage:(...args)=>posts.push(args)} : window;
  const storage = {getItem:()=>{if(blocked)throw Error('denied'); return value;},
    setItem:(k,v)=>{if(blocked)throw Error('denied');writes.push([k,v]);}};
  runInNewContext(source,{window,parent,document,localStorage:storage,
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    addEventListener:(k,fn)=>handlers[k]=fn});
  return {api:window.KRTheme,root,handlers,posts,writes,attrs,parent,frame};
}
test('theme dark default, invalid storage, blocked storage and persistence',()=>{
  for(const value of [null,'','system','<script>']) assert.equal(boot(value).api.get(),'dark');
  const denied=boot('light',true); assert.equal(denied.api.get(),'dark');
  denied.api.set('light'); assert.equal(denied.api.get(),'light');
  const x=boot('light'); assert.equal(x.root.dataset.theme,'light');
  x.api.set('dark'); assert.deepEqual(x.writes,[['kr.theme','dark']]);
  assert.equal(x.attrs['aria-pressed'],'true');
  assert.equal(x.attrs['aria-label'],'Switch to light theme');
  x.api.set('bogus'); assert.equal(x.api.get(),'dark');
});
test('opaque child only accepts its parent and never echoes inbound theme',()=>{
  const x=boot(null,true,true);
  x.handlers.message({source:{},data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'dark');
  x.handlers.message({source:x.parent,data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'light');
  assert.equal(x.posts.length,0);
  x.api.set('dark'); assert.equal(x.posts.length,1);
  assert.equal(x.posts[0][0].kicadReviewTheme,'dark');
});
test('wrapper synchronizes only actual frame, storage changes and ready events',()=>{
  const x=boot(null);
  x.handlers.message({source:{},data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'dark');
  x.handlers.message({source:x.frame,data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'light');
  assert.equal(x.posts.length,0);
  x.handlers.message({source:x.frame,data:{kicadReviewReady:true}});assert.equal(x.posts.length,1);
  x.handlers.storage({key:'kr.theme',newValue:'dark'});assert.equal(x.api.get(),'dark');
  x.handlers.storage({key:'kr.theme',newValue:null});assert.equal(x.api.get(),'dark');
});

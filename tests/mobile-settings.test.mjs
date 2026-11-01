import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function moduleAt(file, globals={}) {
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const mod={exports:{}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module:mod,exports:mod.exports,Date,Error,ArrayBuffer,Uint8Array,...globals});
  return mod.exports;
}
const {bindTabHeaderDrag,revealSelectedTab}=moduleAt('src/lib/settings/tab_navigation.ts');
function header() {
  const handlers=new Map(); const remembered=[];
  const el={scrollLeft:120,addEventListener(k,f){handlers.set(k,f)},removeEventListener(k){handlers.delete(k)},getBoundingClientRect:()=>({left:0,right:300})};
  const dispose=bindTabHeaderDrag(el,x=>remembered.push(x));
  function event(x=0,y=0){return {touches:[{clientX:x,clientY:y}],cancelable:true,prevented:false,stopped:false,preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true},stopImmediatePropagation(){this.stopped=true}}}
  return {el,handlers,remembered,dispose,event};
}
test('horizontal touch drag moves header, saves position and suppresses accidental tab selection',()=>{
  const f=header(); f.handlers.get('touchstart')(f.event(260,10));
  const move=f.event(60,13);f.handlers.get('touchmove')(move);
  assert.equal(f.el.scrollLeft,320);assert.equal(f.remembered.at(-1),320);assert.ok(move.prevented&&move.stopped);
  f.handlers.get('touchend')(f.event());const click=f.event();f.handlers.get('click')(click);
  assert.ok(click.prevented&&click.stopped);f.dispose();assert.equal(f.handlers.size,0);
});
test('vertical touch remains available to page scrolling',()=>{
  const f=header();f.handlers.get('touchstart')(f.event(100,10));const move=f.event(103,110);f.handlers.get('touchmove')(move);
  assert.equal(f.el.scrollLeft,120);assert.equal(move.prevented,false);f.dispose();
});
test('revealing selection only moves its own header the required distance',()=>{
  const f=header();revealSelectedTab(f.el,{getBoundingClientRect:()=>({left:280,right:340})});assert.equal(f.el.scrollLeft,160);
  revealSelectedTab(f.el,{getBoundingClientRect:()=>({left:10,right:90})});assert.equal(f.el.scrollLeft,160);f.dispose();
});
const source=fs.readFileSync(new URL('../src/setting.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('setting.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='SettingTab');
function classMethods(names,globals={}) {
  const methods=cls.members.filter(n=>names.includes(n.name?.getText(ast))).map(n=>n.getText(ast)).join('\n');
  const js=ts.transpileModule(`export class Harness {${methods}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{}};vm.runInNewContext(js,{module:mod,exports:mod.exports,dump(){},window:{requestAnimationFrame:f=>f()},...globals});return new mod.exports.Harness();
}
test('external display refresh preserves mounted remote input and scroll position',()=>{
  const content={childElementCount:1,empty:()=>assert.fail('Remote inputs must remain mounted')};const head={};
  const h=classMethods(['display']);Object.assign(h,{component:{load(){}},forceRebuild:false,lastViewMode:'REMOTE',activeTab:'REMOTE',searchQuery:'',headerDragTarget:head,roots:[],updateHeaderSelection(){}});
  h.containerEl={scrollTop:75,querySelector:s=>s.includes('content')?content:head,empty:()=>assert.fail('Container must remain mounted')};
  for(let i=0;i<30;i++) h.display();assert.equal(h.containerEl.scrollTop,75);
});
test('explicit refresh still requests a rebuild',()=>{
  const h=classMethods(['refresh']);let called=0;h.display=()=>called++;h.refresh();assert.equal(h.forceRebuild,true);assert.equal(called,1);
});
const {formatDiagnostic}=moduleAt('src/lib/utils/redact_log.ts');
test('diagnostics redact nested credentials and note bodies while retaining useful state',()=>{
  const value={action:'NoteModify',path:'test.md',size:42,apiToken:'secret-1',nested:{Authorization:'secret-2',body:'private note'},content:'private note',binary:new Uint8Array([1,2])};
  const result=formatDiagnostic(value);assert.ok(result.includes('NoteModify')&&result.includes('test.md'));assert.ok(!result.includes('secret-')&&!result.includes('private note'));assert.ok(result.includes('[binary omitted]'));
});
test('diagnostics redact encoded JSON, URL tokens, bearer tokens and errors',()=>{
  for(const value of ['{"apiToken":"secret-3","content":"private note"}', 'https://test.invalid/ws?apiToken=secret-4&vault=test',new Error('Bearer secret-5'), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature']) {
    const result=formatDiagnostic(value);assert.ok(!result.includes('secret-')&&!result.includes('private note')&&!result.includes('eyJ'));
  }
  const cycle={action:'state'};cycle.self=cycle;assert.ok(formatDiagnostic(cycle).includes('[circular]'));
});

// Run the actual connection effect with a minimal hook scheduler. State changes
// cause re-renders, so a failed request must not retrigger itself indefinitely.
const viewSource=fs.readFileSync(new URL('../src/views/settings-view.tsx',import.meta.url),'utf8');
const viewAst=ts.createSourceFile('settings-view.tsx',viewSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let userEffect;
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(viewAst)==='useEffect'&&n.arguments[0]?.getText(viewAst).includes('getUserInfo()')) userEffect=n;ts.forEachChild(n,walk)}walk(viewAst);
assert.ok(userEffect);
function effectHarness(api) {
  let oldDeps,cleanup,calls=0,currentApi=api,connected=true;
  const source=`export function render(plugin,isConnected,isMounted,setUserInfo){${userEffect.getText(viewAst)}}`;
  const mod={exports:{}};
  const useEffect=(effect,deps)=>{if(oldDeps&&deps.every((x,i)=>Object.is(x,oldDeps[i])))return;cleanup?.();oldDeps=deps;cleanup=effect();};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:mod,exports:mod.exports,useEffect,dump(){}});
  function render(){calls++;mod.exports.render({api:currentApi},connected,{current:true},()=>render())}
  return {render,reconnect(){connected=false;render();connected=true;render()},switchApi(api){currentApi=api;render()},unmount(){cleanup?.()},renders:()=>calls};
}
test('user info success and subsequent re-renders do not refetch; reconnect may fetch again',async()=>{
  let requests=0;const h=effectHarness({getUserInfo:async()=>{requests++;return{name:'test'}}});h.render();await new Promise(setImmediate);
  for(let i=0;i<20;i++)h.render();assert.equal(requests,1);
  h.reconnect();await new Promise(setImmediate);assert.equal(requests,2);h.unmount();
});
test('a user info failure does not start an immediate retry loop',async()=>{
  let requests=0;const h=effectHarness({getUserInfo:async()=>{requests++;throw Error('offline')}});h.render();await new Promise(setImmediate);
  for(let i=0;i<20;i++)h.render();assert.equal(requests,1);h.unmount();
});

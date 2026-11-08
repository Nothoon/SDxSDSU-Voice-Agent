import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDemoAdapters } from '../public/demo-adapters.js';
async function harness() {
  const elements = { app:{innerHTML:''},main:{focus(){}},timer:{textContent:''} };
  const context=vm.createContext({createDemoAdapters,crypto:globalThis.crypto,structuredClone,Date,console,setInterval(){},window:{addEventListener(){}},document:{getElementById:id=>elements[id],addEventListener(){}}});
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/,'');
  vm.runInContext(source,context);
  return {run:code=>vm.runInContext(code,context),elements};
}
test('prepare → preflight → cue → More → pause/resume → recap clears session', async()=>{
  const {run,elements}=await harness();
  run('actions.approve()');assert.match(elements.app.innerHTML,/Ready when you are/);
  await run('actions.mic()');await run('actions.preview()');await run('actions.start()');
  await run('actions.cue()');const id=run('cue.cardId');await run('actions.more()');assert.equal(run('cue.cardId'),id);assert.equal(run('cue.level'),'expanded');
  await run('actions.pause()');assert.equal(run('state.lifecycle'),'paused');await run('actions.resume()');assert.equal(run('state.lifecycle'),'listening');
  run("state=session.fixture({cardId:cards[3].id,status:'covered',text:'Out-of-order finalized fixture'})");
  run("state=session.fixture({disconnected:true})");assert.equal(run('state.coverage[cards[3].id]'),'covered');
  await run('actions.end()');assert.equal(run('stage'),'recap');assert.equal(run('state.segments.length'),0);assert.equal(run('Object.keys(state.coverage).length'),0);assert.equal(run('recap.covered'),1);
});
test('late cue cannot replace a manual selection or an ended session',async()=>{
  const {run}=await harness();await run('actions.start()');
  run('let resolveLate; session.cue=()=>new Promise(resolve=>{resolveLate=resolve;});');
  const pending=run('actions.cue()');run('invalidate(); selected=cards[2].id;');
  run("resolveLate({requestId:'1',cardId:cards[0].id,text:'Stale cue',stateRevision:state.revision});");await pending;assert.equal(run('cue'),null);
  const pending2=run('actions.cue()');await run('actions.end()');run("resolveLate({requestId:'3',cardId:'stale',text:'Stale after end',stateRevision:state.revision});");await pending2;assert.equal(run('cue'),null);assert.equal(run('stage'),'recap');
});
test('More text fallback retains the last idea on synthesis error',async()=>{
  const {run}=await harness();await run('actions.start()');await run('actions.cue()');const id=run('cue.cardId');run("session.cue=async()=>{throw Error('Offline')}");await run('actions.more()');assert.equal(run('cue.cardId'),id);assert.equal(run('cue.text'),run('cards[0].expandedCue'));
});

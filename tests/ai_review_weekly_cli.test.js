'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executeWeekly}=require('../services/ai-review/weekly-command');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-week-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const manifest=path.join(root,'manifest.json');const argv=['--manifest',manifest,'--desk-root',root,'--output-root',path.join(root,'output'),'--date','2026-11-09'];return {root,manifest,argv};}
test('weekly command reports every required book and one directions artifact with zero fetch on absent inputs',async t=>{
 const f=setup(t);let calls=0;const r=await executeWeekly({argv:f.argv,env:{AI_REVIEW_ENABLED:'1'},planIntake:()=>{throw Error('not called');},fetchFn:async()=>{calls++;throw Error('no network');}});
 assert.equal(r.reviews.length,7);assert.equal(r.completeWeeklyReady,false);assert.equal(calls,0);
 for(const row of [...r.reviews,r.directions]){const d=JSON.parse(fs.readFileSync(row.jsonFile));assert.equal(d.status,'INPUT_MISSING');assert.ok(fs.existsSync(row.markdownFile));}
});
test('weekly manifest cannot promote coverage or supply validator code',async t=>{
 const f=setup(t);fs.writeFileSync(f.manifest,JSON.stringify({period:'2026-11-09',sources:[],requests:[],completeWeeklyReady:true,deskRoot:'/untrusted'}));
 const r=await executeWeekly({argv:f.argv,env:{AI_REVIEW_ENABLED:'1'},planIntake:()=>({accepted:[],rejected:[]}),fetchFn:()=>assert.fail('network')});
 assert.equal(r.completeWeeklyReady,false);assert.equal(r.manifestState,'INVALID');
});
test('manifest wrong period never substitutes a historical week',async t=>{
 const f=setup(t);fs.writeFileSync(f.manifest,JSON.stringify({period:'2026-11-02',sources:[],requests:[]}));
 const r=await executeWeekly({argv:f.argv,env:{AI_REVIEW_ENABLED:'1'},planIntake:()=>assert.fail('intake')});
 assert.equal(r.manifestState,'STALE');assert.equal(r.reviews.length,7);
});
test('weekly arguments reject relative paths and repeated options before reading',async()=>{
 await assert.rejects(executeWeekly({argv:['--manifest','relative','--desk-root','/tmp']}),/WEEKLY_ARGUMENTS_INVALID/);
 await assert.rejects(executeWeekly({argv:['--manifest','/tmp/a','--desk-root','/tmp','--date','2026-02-30']}),/WEEKLY_ARGUMENTS_INVALID/);
});

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
test('weekly CLI retains exact attribution facts while complete coverage remains pending',async t=>{
 const f=setup(t),{contentHash,sha256}=require('../services/desk-review-routing/canonical');
 const doc={schemaVersion:2,producer:'SMARTFLOW',market:'US',currency:'USD',sessionDate:'2026-11-06',lossAttribution:{plan:'LOSS_ATTRIBUTION_V1@1',accountBasis:'PAPER_BOOK_IS_THE_ACCOUNT',books:[{ledgerId:'US_V5_ETF_3000USD',windows:[{id:'WEEK',from:'2026-11-02',to:'2026-11-06',status:'PARTIAL',net:{value:null,state:'UNKNOWN'}}]}]}};
 doc.hash=contentHash(doc);const file=path.join(f.root,'attribution.json');fs.writeFileSync(file,JSON.stringify(doc));
 fs.writeFileSync(f.manifest,JSON.stringify({period:'2026-11-09',sources:[{file,fileName:'REVIEW_DECOMPOSITION_V2_2026-11-06.json',producer:'SMARTFLOW_US',sha256:sha256(fs.readFileSync(file))}],requests:[{ledger:'US_V5_ETF_3000USD',market:'US',from:'2026-11-02',to:'2026-11-06',attributionDate:'2026-11-06',attributionSourceFile:file}]}));
 const r=await executeWeekly({argv:f.argv,env:{AI_REVIEW_ENABLED:'1'},planIntake:()=>({accepted:[],rejected:[]}),validateContract:()=>({ok:true}),fetchFn:()=>assert.fail('network')});
 const row=r.reviews.find(x=>x.result.ledger==='US_V5_ETF_3000USD');assert.equal(row.result.facts.length,1);assert.equal(row.result.facts[0].data.window.id,'WEEK');assert.equal(row.result.status,'INPUT_MISSING');assert.equal(r.completeWeeklyReady,false);
});
test('weekly CLI retains hash-bound coordinator rule rows as facts without granting complete coverage',async t=>{
 const f=setup(t),{contentHash,sha256}=require('../services/desk-review-routing/canonical');
 const doc={schemaVersion:'RULE_CHANGE_LEDGER_V1',producer:'COORDINATOR',generatedAt:'2026-11-09T01:00:00Z',realOrder:0,brokerWrite:false,rows:[{changeId:'RCL-US-20261106-1',ledgerIds:['US_V5_ETF_3000USD'],state:'NO_BASIS',ownerConfirmation:null}]};
 doc.hash=contentHash(doc);const file=path.join(f.root,'RULE_CHANGE_LEDGER.json');fs.writeFileSync(file,JSON.stringify(doc));
 fs.writeFileSync(f.manifest,JSON.stringify({period:'2026-11-09',sources:[{file,fileName:'RULE_CHANGE_LEDGER.json',producer:'COORDINATOR',sha256:sha256(fs.readFileSync(file))}],requests:[{ledger:'US_V5_ETF_3000USD',market:'US',from:'2026-11-02',to:'2026-11-06',ruleChangeSourceFile:file}]}));
 const r=await executeWeekly({argv:f.argv,now:()=>new Date('2026-11-09T01:05Z'),env:{AI_REVIEW_ENABLED:'1'},planIntake:()=>({accepted:[],rejected:[]}),validateContract:()=>({ok:true}),fetchFn:()=>assert.fail('network')});
 const row=r.reviews.find(x=>x.result.ledger==='US_V5_ETF_3000USD');assert.equal(row.result.facts.length,1);assert.equal(row.result.facts[0].sourceContract,'RULE_CHANGE_LEDGER_V1');assert.deepEqual(row.result.facts[0].data.rows,doc.rows);assert.equal(row.result.status,'INPUT_MISSING');assert.equal(r.completeWeeklyReady,false);
});

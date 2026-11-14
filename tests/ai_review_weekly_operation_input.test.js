'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sha256}=require('../services/desk-review-routing/canonical');
const {readWeeklyOperations}=require('../services/ai-review/weekly-operation-input');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-week-op-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const doc={contract:'OPERATION_REVIEW_V1',market:'US',period:{kind:'WEEK',from:'2026-11-02',to:'2026-11-06',sessions:['2026-11-02','2026-11-06']},books:[{ledgerId:'US_V5_ETF_3000USD',weekState:{state:'NO_OPERATION',reasonCode:null},pnlSplit:{amount:null,state:'NOT_MEASURED'}},{ledgerId:'OTHER',pnlSplit:{amount:999}}],week:{readiness:{state:'READY',reasonCode:null}},hash:'a'.repeat(64)};
 const file=path.join(root,'week.json');fs.writeFileSync(file,JSON.stringify(doc));const source={file,fileName:'OPERATION_REVIEW_US_WEEK_2026-11-06.json',producer:'SMARTFLOW_US',sha256:sha256(fs.readFileSync(file))};
 const request={ledger:'US_V5_ETF_3000USD',market:'US',from:'2026-11-02',to:'2026-11-06',sourceFile:file};
 let calls=0;
 const planIntake=({files})=>{calls++;return {accepted:files.map(f=>({...f,contract:f.payload.contract,value:f.payload})),rejected:[]};};
 return {doc,source,request,run:(extra={})=>readWeeklyOperations({period:'2026-11-09',sources:[source],requests:[request],nowMs:Date.parse('2026-11-09T01:05:00Z'),planIntake,...extra}),calls:()=>calls};
}
test('weekly operations reuses canonical intake and copies only exact ledger facts',t=>{const f=setup(t),[p]=f.run();assert.equal(f.calls(),1);assert.equal(p.inputState,'READY');assert.equal(p.coverage,'WEEKLY_OPERATION_SLICE');assert.equal(p.facts[0].data.book.ledgerId,f.request.ledger);assert.equal(p.facts[0].data.book.pnlSplit.amount,null);assert.equal(JSON.stringify(p).includes('999'),false);assert.equal(p.facts[0].sourceSha256,f.source.sha256);});
test('weekly operation intake refusal including cross-file failure blocks model-ready input',t=>{const f=setup(t);const [p]=f.run({planIntake:({files})=>({accepted:[],rejected:files.map(f=>({...f,reason:'OPERATION_WEEK_BINDING'}))})});assert.equal(p.inputState,'INPUT_MISSING');assert.equal(p.states[0].reason,'OPERATION_WEEK_BINDING');assert.deepEqual(p.facts,[]);});
test('changed bytes refuse before canonical validator',t=>{const f=setup(t);fs.appendFileSync(f.source.file,' ');const [p]=f.run();assert.equal(p.inputState,'INPUT_MISSING');assert.equal(f.calls(),0);});
test('wrong week stays stale and is not silently replaced',t=>{const f=setup(t);const [p]=f.run({period:'2026-11-16',requests:[{...f.request,to:'2026-11-13'}]});assert.equal(p.inputState,'INPUT_STALE');assert.deepEqual(p.facts,[]);});
test('A-share aggregate cannot be relabelled as an INDEX book',t=>{const f=setup(t);const [p]=f.run({requests:[{...f.request,ledger:'ASHARE_V6_PAPER:INDEX',market:'CN'}]});assert.equal(p.inputState,'INPUT_MISSING');assert.equal(p.states[0].reason,'WEEKLY_PART_NOT_DELIVERED');});
test('missing validator and ambiguous source selection are explicit missing states',t=>{const f=setup(t);assert.equal(f.run({planIntake:null})[0].states[0].reason,'CANONICAL_INTAKE_UNAVAILABLE');assert.equal(f.run({sources:[f.source,f.source]})[0].inputState,'INPUT_MISSING');});

test('producer incomplete week remains missing while factual provenance is retained',t=>{
 const f=setup(t);f.doc.week.readiness={state:'DEGRADED',reasonCode:'DAY_NOT_DELIVERED:2026-11-02'};f.doc.books[0].weekState={state:'INCOMPLETE',reasonCode:'DAY_NOT_DELIVERED:2026-11-02'};
 fs.writeFileSync(f.source.file,JSON.stringify(f.doc));f.source.sha256=sha256(fs.readFileSync(f.source.file));
 const [p]=f.run();assert.equal(p.inputState,'INPUT_MISSING');assert.equal(p.states[0].reason,'WEEKLY_PRODUCER_INCOMPLETE');assert.equal(p.facts[0].data.readiness.state,'DEGRADED');assert.equal(p.facts[0].data.book.weekState.reasonCode,'DAY_NOT_DELIVERED:2026-11-02');
});

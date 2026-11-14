'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sha256,contentHash}=require('../services/desk-review-routing/canonical');
const {readWeeklyAttribution}=require('../services/ai-review/weekly-attribution-input');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'q70-week-loss-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const window={id:'WEEK',from:'2026-11-02',to:'2026-11-06',status:'PARTIAL',blocks:{execution:{state:'UNKNOWN',value:null,reasonCode:'NO_RULE_PRICE'}}};
 const doc={schemaVersion:2,producer:'SMARTFLOW',market:'US',currency:'USD',sessionDate:'2026-11-06',lossAttribution:{plan:'LOSS_ATTRIBUTION_V1@1',accountBasis:'PAPER_BOOK_IS_THE_ACCOUNT',books:[{ledgerId:'US_V5_ETF_3000USD',ruleVersion:{state:'UNKNOWN'},windows:[window,{...window,id:'SINCE_OPEN',from:'2026-10-08'}]},{ledgerId:'OTHER',windows:[{...window,net:999}]}]}};
 doc.hash=contentHash(doc);const file=path.join(dir,'loss.json');fs.writeFileSync(file,JSON.stringify(doc));
 const request={ledger:'US_V5_ETF_3000USD',from:'2026-11-02',to:'2026-11-06',attributionDate:'2026-11-06',source:{file,sha256:sha256(fs.readFileSync(file))}};
 return {doc,window,request,run:(extra={})=>readWeeklyAttribution({period:'2026-11-09',request,nowMs:Date.parse('2026-11-09T01:05Z'),validateContract:()=>({ok:true}),...extra})};}
test('weekly attribution takes exact WEEK and book, preserves unknown and producer status',t=>{const f=setup(t),r=f.run();assert.equal(r.state.status,'READY');assert.deepEqual(r.fact.data.window,f.window);assert.equal(r.fact.data.window.blocks.execution.value,null);assert.equal(JSON.stringify(r).includes('999'),false);assert.equal(JSON.stringify(r).includes('SINCE_OPEN'),false);});
test('weekly attribution refuses other periods rather than borrowing since-open window',t=>{const f=setup(t),r=f.run({request:{...f.request,from:'2026-10-08'}});assert.equal(r.state.status,'INPUT_STALE');assert.equal(r.fact,null);});
test('weekly attribution retains canonical rejection and requires its validator',t=>{const f=setup(t);assert.equal(f.run({validateContract:null}).state.status,'INPUT_MISSING');const r=f.run({validateContract:()=>({ok:false,reason:'LOSS_ATTRIBUTION_SUM'})});assert.equal(r.state.reason,'LOSS_ATTRIBUTION_SUM');assert.equal(r.fact,null);});
test('weekly attribution rejects changed source bytes',t=>{const f=setup(t);fs.appendFileSync(f.request.source.file,' ');assert.equal(f.run().state.reason,'SOURCE_HASH');});

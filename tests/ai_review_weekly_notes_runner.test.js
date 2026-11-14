'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runWeeklyNotes } = require('../services/ai-review/weekly-notes-runner');
const pack = (output, ledger) => ({ period: '2026-11-09', output, ledger, inputState: 'INPUT_MISSING', facts: [], states: [{ status: 'INPUT_MISSING', reason: 'WEEKLY_SOURCE_NOT_DELIVERED' }] });
test('weekly note delivery preserves missing facts with no model request', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-weekly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;
 const result=await runWeeklyNotes({root,reviewPacks:[pack('WEEKLY_REVIEW','ASHARE_V6_PAPER:INDEX'),pack('WEEKLY_REVIEW','US_V5_ETF_3000USD')],directionsPack:pack('WEEKLY_DIRECTIONS','ALL_LEDGERS'),enabled:true,fetchFn:async()=>{calls++;throw Error('must not call');}});
 assert.equal(result.reviews.length,2);assert.equal(result.directions.result.status,'INPUT_MISSING');assert.equal(calls,0);
 for(const row of [...result.reviews,result.directions]){assert.deepEqual(JSON.parse(fs.readFileSync(row.jsonFile)),row.result);assert.ok(fs.existsSync(row.markdownFile));assert.equal(row.result.states[0].reason,'WEEKLY_SOURCE_NOT_DELIVERED');}
});
test('weekly runner rejects mixed periods, duplicate books and multiple global directions before writing',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-weekly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const valid=pack('WEEKLY_REVIEW','ASHARE_V6_PAPER:INDEX');
 for(const args of [
  {reviewPacks:[valid,valid],directionsPack:pack('WEEKLY_DIRECTIONS','ALL_LEDGERS')},
  {reviewPacks:[valid],directionsPack:{...pack('WEEKLY_DIRECTIONS','ALL_LEDGERS'),period:'2026-11-16'}},
  {reviewPacks:[{...valid,ledger:'../../escape'}],directionsPack:pack('WEEKLY_DIRECTIONS','ALL_LEDGERS')},
  {reviewPacks:[valid],directionsPack:[pack('WEEKLY_DIRECTIONS','ALL_LEDGERS')]},
 ])await assert.rejects(runWeeklyNotes({root,...args}),/WEEKLY_SCOPE_INVALID/);
 assert.deepEqual(fs.readdirSync(root),[]);
});
test('weekly delivery retains default-off and unset-budget gates for both outputs', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-weekly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;
 const ready=p=>({...p,inputState:'READY',facts:[{id:'F1',text:'已交付事实'}]});
 const args={root,reviewPacks:[ready(pack('WEEKLY_REVIEW','ASHARE_V6_PAPER:INDEX'))],directionsPack:ready(pack('WEEKLY_DIRECTIONS','ALL_LEDGERS')),budget:null,fetchFn:async()=>{calls++;throw Error('must not call');}};
 for(const [enabled,status] of [[false,'DISABLED'],[true,'BLOCKED:BUDGET']]){
  const rows=await runWeeklyNotes({...args,enabled});
  assert.equal(rows.reviews[0].result.status,status);assert.equal(rows.directions.result.status,status);
 }
 assert.equal(calls,0);assert.equal(fs.existsSync(path.join(root,'usage.jsonl')),false);
});

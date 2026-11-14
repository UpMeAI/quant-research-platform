'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runWeeklyPending}=require('../services/ai-review/weekly-pending-runner');
test('weekly pending delivery writes distinct deterministic reports with no model call',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'q70-weekly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;const args={period:'2026-11-14',requests:[{entryId:'../../bad',resultId:'R1',strategyRef:'US_V5'},{entryId:'E2',resultId:'R2',strategyRef:'US_CORE'}],stores:[],root,fetchFn:()=>{calls++;throw Error('NO_CALL');}};
 const first=await runWeeklyPending(args);assert.equal(first.length,2);assert.notEqual(first[0].jsonFile,first[1].jsonFile);
 for(const row of first){const result=JSON.parse(fs.readFileSync(row.jsonFile));assert.equal(result.status,'WEEKLY_BINDING_PENDING');assert.equal(result.sourceReason,'SEALED_ENTRY_NOT_REGISTERED');assert.equal(result.comparison,null);assert.equal(result.tradeAuthority,false);assert.ok(fs.readFileSync(row.markdownFile,'utf8').includes('WEEKLY_BINDING_PENDING'));assert.ok(row.jsonFile.startsWith(root+'/2026-11-14/ledger-'));}
 const before=first.map(r=>fs.readFileSync(r.jsonFile,'utf8'));await runWeeklyPending(args);assert.deepEqual(first.map(r=>fs.readFileSync(r.jsonFile,'utf8')),before);const reversed=await runWeeklyPending({...args,requests:[...args.requests].reverse()});assert.equal(reversed[0].jsonFile,first[1].jsonFile);assert.equal(calls,0);assert.ok(!fs.existsSync(path.join(root,'usage.jsonl')));
});
test('weekly pending delivery refuses invalid date before creating output',async()=>{
 await assert.rejects(runWeeklyPending({period:'2026-02-30',requests:[],stores:[],root:'/path-not-to-create'}),/WEEKLY_SEALED_ARGUMENTS/);
});
test('weekly pending CLI accepts explicit requests and rejects repeated or relative arguments',t=>{
 const {spawnSync}=require('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'q70-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const requests=path.join(dir,'requests.json');fs.writeFileSync(requests,JSON.stringify([{entryId:'NOT_REGISTERED',resultId:'R',strategyRef:'US_V5'}]));
 const cli=path.resolve(__dirname,'../apps/research-cli/ai_review_weekly_pending.js');
 const valid=['--requests',requests,'--date','2026-11-14','--output-root',path.join(dir,'out')];
 const result=spawnSync(process.execPath,[cli,...valid],{encoding:'utf8',env:{...process.env,AI_REVIEW_ENABLED:'1'}});
 assert.equal(result.status,0,result.stderr);const summary=JSON.parse(result.stdout);assert.equal(summary.rows[0].status,'WEEKLY_BINDING_PENDING');assert.equal(summary.comparisonReady,false);
 for(const args of [[...valid,'--date','2026-11-14'],['--requests','relative.json'],['--requests',requests,'--date','2026-02-30']]){const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(r.status,64);assert.ok(!r.stderr.includes(requests));}
});

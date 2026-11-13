'use strict';
const fs = require('node:fs'), path = require('node:path');
const { cstDate } = require('./daily-command');
const { dailyBookRequests } = require('./desk-input');
const { readWeeklyOperations } = require('./weekly-operation-input');
const { runWeeklyNotes } = require('./weekly-notes-runner');
const { readWeeklyAttribution } = require('./weekly-attribution-input');
const { readRuleChanges } = require('./rule-change-input');
const { sha256 } = require('../desk-review-routing/canonical');
function parseArgs(argv, now) {
 const values = {};
 for(let i=0;i<argv.length;i+=2){
  const k=argv[i],v=argv[i+1];
  if(!['--manifest','--desk-root','--output-root','--date'].includes(k)||k in values||!v||v.startsWith('--'))throw Error('WEEKLY_ARGUMENTS_INVALID');
  values[k]=v;
 }
 for(const k of ['--manifest','--desk-root'])if(!values[k]||!path.isAbsolute(values[k]))throw Error('WEEKLY_ARGUMENTS_INVALID');
 if(values['--output-root']&&!path.isAbsolute(values['--output-root']))throw Error('WEEKLY_ARGUMENTS_INVALID');
 const period=values['--date']||cstDate(now);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(period)||!Number.isFinite(Date.parse(period))||new Date(period).toISOString().slice(0,10)!==period)throw Error('WEEKLY_ARGUMENTS_INVALID');
 return {period,manifest:values['--manifest'],deskRoot:values['--desk-root'],root:values['--output-root']||path.resolve(__dirname,'../../var/ai-review')};
}
async function executeWeekly({argv,env=process.env,now=()=>new Date(),planIntake,validateContract,fetchFn=globalThis.fetch}){
 const instant=now(),args=parseArgs(argv,instant);
 let manifestState='MISSING',manifest=null,manifestSha256=null;
 try{
  const bytes=fs.readFileSync(args.manifest);manifestSha256=sha256(bytes);const value=JSON.parse(bytes);
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['period','sources','requests'].includes(k))||!Array.isArray(value.sources)||!Array.isArray(value.requests))manifestState='INVALID';
  else if(value.period!==args.period)manifestState='STALE';
  else {manifestState='AVAILABLE';manifest=value;}
 }catch{manifestState=fs.existsSync(args.manifest)?'INVALID':'MISSING';}
 if(planIntake===undefined){try{planIntake=require(path.join(args.deskRoot,'src/inbox/intake')).planIntake;}catch{planIntake=null;}}
 if(validateContract===undefined){try{validateContract=require(path.join(args.deskRoot,'src/validate')).validateContract;}catch{validateContract=null;}}
 const required=dailyBookRequests().map(b=>({ledger:b.ledgerId+(b.partId?`:${b.partId}`:''),market:b.market}));
 required.push({ledger:'CARRY_V2_SHADOW_10000USDT',market:'CRYPTO'});
 const requests=required.map(book=>{
  const matches=manifest?.requests.filter(r=>r&&r.ledger===book.ledger&&r.market===book.market)||[];
  return matches.length===1?matches[0]:book;
 });
 const slices=manifest?readWeeklyOperations({period:args.period,sources:manifest.sources,requests,nowMs:instant.getTime(),planIntake}):required.map(book=>({period:args.period,output:'WEEKLY_REVIEW',ledger:book.ledger,facts:[],states:[{ledger:book.ledger,status:manifestState==='STALE'?'INPUT_STALE':'INPUT_MISSING',reason:`WEEKLY_MANIFEST_${manifestState}`}],inputState:manifestState==='STALE'?'INPUT_STALE':'INPUT_MISSING',coverage:'WEEKLY_OPERATION_SLICE'}));
 for(const [index,pack] of slices.entries()){
  const request=requests[index];
  const sources=manifest?.sources.filter(s=>s&&s.file===request.attributionSourceFile)||[];
  const result=readWeeklyAttribution({period:args.period,request:{...request,source:sources.length===1?sources[0]:null},nowMs:instant.getTime(),validateContract});
  pack.states.push({...result.state,sourceContract:'REVIEW_DECOMPOSITION_V2'});
  if(result.fact)pack.facts.push({...result.fact,id:`F${pack.facts.length+1}`});
  const ruleSources=manifest?.sources.filter(s=>s&&s.file===request.ruleChangeSourceFile)||[];
  const changes=readRuleChanges({ledger:pack.ledger,source:ruleSources.length===1?ruleSources[0]:null,nowMs:instant.getTime(),validateContract});
  pack.states.push({...changes.state,sourceContract:'RULE_CHANGE_LEDGER_V1'});
  if(changes.fact)pack.facts.push({...changes.fact,id:`F${pack.facts.length+1}`});
 }
 // Source slices do not certify complete period coverage. This gate is
 // canonical code, not an operator manifest assertion. No partial model review.
 const reviewPacks=slices.map(p=>({...p,inputState:p.inputState==='INPUT_STALE'?'INPUT_STALE':'INPUT_MISSING',states:[...p.states,{ledger:p.ledger,status:'INPUT_MISSING',reason:'COMPLETE_WEEKLY_COVERAGE_PENDING'}]}));
 const directionsPack={period:args.period,output:'WEEKLY_DIRECTIONS',ledger:'ALL_LEDGERS',coverage:'WEEKLY_OPERATION_SLICE',inputState:'INPUT_MISSING',facts:slices.flatMap(p=>p.facts).map((f,i)=>({...f,id:`F${i+1}`})),states:[{status:'INPUT_MISSING',reason:'COMPLETE_WEEKLY_COVERAGE_PENDING'}]};
 const delivered=await runWeeklyNotes({root:args.root,reviewPacks,directionsPack,enabled:env.AI_REVIEW_ENABLED==='1',fetchFn,now:()=>instant});
 return {period:args.period,manifestState,manifestSha256,validatorState:typeof planIntake==='function'?'AVAILABLE':'UNAVAILABLE',completeWeeklyReady:false,...delivered};
}
module.exports={executeWeekly,parseArgs};

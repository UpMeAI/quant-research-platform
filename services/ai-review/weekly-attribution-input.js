'use strict';
// Reuse canonical per-book decomposition validation; select, never calculate,
// the producer's exact WEEK window. No since-open fallback or cross-book totals.
const {readDeskDailyPacks,dailyBookRequests}=require('./desk-input');
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
function readWeeklyAttribution({period,request,nowMs,validateContract}){
 const ledger=request?.ledger??null;
 const missing=(reason,status='INPUT_MISSING')=>({fact:null,state:{ledger,status,reason}});
 if(!request||![period,request.from,request.to,request.attributionDate].every(date)||request.from>request.to||request.to>period||request.attributionDate>period)return missing('WEEKLY_ATTRIBUTION_REQUEST_INVALID');
 const book=dailyBookRequests().find(b=>`${b.ledgerId}${b.partId?`:${b.partId}`:''}`===ledger);
 if(!book)return missing('ATTRIBUTION_BOOK_NOT_REGISTERED');
 const [pack]=readDeskDailyPacks({period:request.attributionDate,requests:[{ledgerId:book.ledgerId,partId:book.partId,sources:{decomposition:request.source}}],nowMs,validateContract});
 const fact=pack.facts.find(f=>f.sourceContract==='REVIEW_DECOMPOSITION_V2');
 if(!fact){const state=pack.states.find(s=>s.sourceContract==='REVIEW_DECOMPOSITION_V2')||pack.states[0];return missing(state?.reason||'ATTRIBUTION_SOURCE_MISSING',state?.status==='INPUT_STALE'?'INPUT_STALE':'INPUT_MISSING');}
 const windows=fact.data.book.windows?.filter(w=>w.id==='WEEK'&&w.from===request.from&&w.to===request.to)||[];
 if(windows.length!==1)return missing('ATTRIBUTION_WEEK_MISMATCH','INPUT_STALE');
 const {windows:ignored,...bookMetadata}=fact.data.book;
 return {fact:{...fact,id:'ATTRIBUTION',data:{sessionDate:fact.data.sessionDate,market:fact.data.market,currency:fact.data.currency,plan:fact.data.plan,accountBasis:fact.data.accountBasis,book:bookMetadata,window:windows[0]}},state:{ledger,status:'READY',reason:null}};
}
module.exports={readWeeklyAttribution};

'use strict';
// Q70 BRIEF §§1/2/4: consume the producer's week and exact book unchanged.
// Canonical Desk planIntake (trusted startup dependency) owns contract, freshness
// and cross-file day/trade validation. This adapter never recomputes week totals.
const fs = require('node:fs');
const { sha256 } = require('../desk-review-routing/canonical');
const { dailyBookRequests } = require('./desk-input');
const books = new Map(dailyBookRequests().map(b => [b.ledgerId, b.market]));
books.set('CARRY_V2_SHADOW_10000USDT', 'CRYPTO');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
function readWeeklyOperations({ period, sources, requests, nowMs, planIntake }) {
 if (!date(period) || !Array.isArray(sources) || !Array.isArray(requests) || !Number.isFinite(nowMs)) throw Error('WEEKLY_INPUT_ARGUMENTS');
 let plan, sourceError = null;
 const byFile = new Map();
 if (typeof planIntake !== 'function') sourceError = 'CANONICAL_INTAKE_UNAVAILABLE';
 else try {
  const files = sources.map(source => {
   if (!source || typeof source.file !== 'string' || typeof source.fileName !== 'string' || typeof source.producer !== 'string' || byFile.has(source.file)) throw Error('SOURCE_SELECTION_INVALID');
   const bytes = fs.readFileSync(source.file);
   if (!/^[a-f0-9]{64}$/.test(source.sha256 || '') || sha256(bytes) !== source.sha256) throw Error('SOURCE_HASH');
   byFile.set(source.file, source);
   return { fileName: source.fileName, producer: source.producer, sourceFile: source.file, payload: JSON.parse(bytes) };
  });
  plan = planIntake({ files, now: new Date(nowMs) });
  if (!plan || !Array.isArray(plan.accepted) || !Array.isArray(plan.rejected)) throw Error('INTAKE_RESULT_INVALID');
 } catch { sourceError = 'WEEKLY_SOURCE_OR_INTAKE_INVALID'; }
 return requests.map(request => {
  const ledger = request?.ledger ?? null;
  const pack = { period, output:'WEEKLY_REVIEW', ledger, facts:[], states:[], inputState:'INPUT_MISSING', coverage:'WEEKLY_OPERATION_SLICE' };
  const refuse = (reason, status='INPUT_MISSING') => { pack.inputState=status;pack.states.push({ledger,status,reason});return pack; };
  if (!request || !date(request.from) || !date(request.to) || request.from > request.to || request.to > period) return refuse('WEEKLY_REQUEST_INVALID');
  if (['ASHARE_V6_PAPER:INDEX','ASHARE_V6_PAPER:STOCK'].includes(ledger)) return refuse('WEEKLY_PART_NOT_DELIVERED');
  if (!books.has(ledger) || books.get(ledger) !== request.market) return refuse('BOOK_NOT_REGISTERED');
  if (sourceError) return refuse(sourceError);
  const rejected = plan.rejected.find(row => row.sourceFile === request.sourceFile);
  if (rejected) return refuse(typeof rejected.reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(rejected.reason) ? rejected.reason : 'PRODUCER_INVALID', rejected.reason === 'SESSION_STALE' ? 'INPUT_STALE' : 'INPUT_MISSING');
  const matches = plan.accepted.filter(row => row.sourceFile === request.sourceFile && row.contract === 'OPERATION_REVIEW_V1');
  if (matches.length !== 1 || !byFile.has(request.sourceFile)) return refuse('WEEKLY_SOURCE_NOT_ACCEPTED');
  const doc = matches[0].value;
  if (!doc || doc.market !== request.market || doc.period?.kind !== 'WEEK') return refuse('PRODUCER_BINDING');
  if (doc.period.from !== request.from || doc.period.to !== request.to) return refuse('WEEK_PERIOD_MISMATCH','INPUT_STALE');
  const rows = Array.isArray(doc.books) ? doc.books.filter(b => b.ledgerId === ledger) : [];
  if (rows.length !== 1) return refuse('WEEKLY_BOOK_BINDING');
  const source = byFile.get(request.sourceFile);
  pack.facts.push({ id:'F1', ledger, sourceFile:source.file, sourceSha256:source.sha256, sourcePayloadSha256:doc.hash, sourceContract:'OPERATION_REVIEW_V1', data:{period:doc.period,readiness:doc.week?.readiness ?? null,book:rows[0]} });
  if (doc.week?.readiness?.state !== 'READY' || rows[0].weekState?.state === 'INCOMPLETE') return refuse('WEEKLY_PRODUCER_INCOMPLETE');
  pack.inputState='READY';pack.states.push({ledger,status:'READY',reason:null});
  return pack;
 });
}
module.exports = { readWeeklyOperations };

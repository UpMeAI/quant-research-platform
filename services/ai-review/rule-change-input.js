'use strict';
// Consume the coordinator's ledger; never reconstruct rule changes from git,
// infer confirmation/effectiveness, or treat an absent ledger as no changes.
const fs = require('node:fs');
const {sha256,contentHash}=require('../desk-review-routing/canonical');
function readRuleChanges({ledger,source,nowMs,validateContract}) {
 const missing=reason=>({fact:null,state:{ledger,status:'INPUT_MISSING',reason},coverage:'RULE_CHANGE_LEDGER_SNAPSHOT',periodCompletenessCertified:false});
 if(!source||typeof source.file!=='string')return missing('RULE_LEDGER_MISSING');
 if(typeof validateContract!=='function')return missing('CANONICAL_VALIDATOR_MISSING');
 if(typeof ledger!=='string'||!ledger||!Number.isFinite(nowMs))return missing('RULE_LEDGER_REQUEST_INVALID');
 let bytes,doc;
 try{bytes=fs.readFileSync(source.file);}catch{return missing('RULE_LEDGER_MISSING');}
 if(!/^[a-f0-9]{64}$/.test(source.sha256||'')||sha256(bytes)!==source.sha256)return missing('SOURCE_HASH');
 try{doc=JSON.parse(bytes);}catch{return missing('SOURCE_JSON');}
 if(!doc||typeof doc!=='object'||Array.isArray(doc)||!doc.hash||contentHash(doc)!==doc.hash)return missing('PAYLOAD_HASH');
 if(doc.schemaVersion!=='RULE_CHANGE_LEDGER_V1'||doc.producer!=='COORDINATOR'||doc.realOrder!==0||doc.brokerWrite!==false)return missing('PRODUCER_BINDING');
 if(!Number.isFinite(Date.parse(doc.generatedAt)))return missing('RULE_LEDGER_GENERATED_AT');
 if(Date.parse(doc.generatedAt)>nowMs)return missing('RULE_LEDGER_FUTURE');
 let valid;
 try{valid=validateContract('RULE_CHANGE_LEDGER_V1',doc,{nowMs});}catch{return missing('CANONICAL_VALIDATOR_FAILED');}
 if(valid?.ok!==true)return missing(/^[A-Z][A-Z0-9_]*$/.test(valid?.reason||'')?valid.reason:'RULE_LEDGER_INVALID');
 if(!Array.isArray(doc.rows)||doc.rows.some(row=>!row||!Array.isArray(row.ledgerIds)))return missing('RULE_LEDGER_INVALID');
 // A split CN book shares its producer ledger; never attribute unscoped changes
 // to that book. Keep unscoped rows explicitly separate as context only.
 const producerLedger=ledger.split(':')[0];
 return {fact:{id:'RULE_CHANGES',ledger,sourceFile:source.file,sourceSha256:source.sha256,sourcePayloadSha256:doc.hash,sourceContract:'RULE_CHANGE_LEDGER_V1',scope:'LEDGER',data:{generatedAt:doc.generatedAt,compiledFrom:doc.compiledFrom??null,rows:doc.rows.filter(r=>r.ledgerIds.includes(producerLedger)),unscopedRows:doc.rows.filter(r=>r.ledgerIds.length===0),unscopedContextOnly:true}},state:{ledger,status:'READY',reason:null},coverage:'RULE_CHANGE_LEDGER_SNAPSHOT',periodCompletenessCertified:false};
}
module.exports={readRuleChanges};

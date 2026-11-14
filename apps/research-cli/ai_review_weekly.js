#!/usr/bin/env node
'use strict';
const {executeWeekly}=require('../../services/ai-review/weekly-command');
executeWeekly({argv:process.argv.slice(2)}).then(result=>{
 // Print status and artifact paths only, not source facts or provider payloads.
 const brief=row=>({status:row.result.status,jsonFile:row.jsonFile,markdownFile:row.markdownFile});
 const {reviews,directions,...meta}=result;
 process.stdout.write(`${JSON.stringify({...meta,reviews:reviews.map(brief),directions:brief(directions)})}\n`);
}).catch(error=>{const invalid=error.message==='WEEKLY_ARGUMENTS_INVALID';process.stderr.write(`${invalid?'WEEKLY_ARGUMENTS_INVALID':'WEEKLY_COMMAND_FAILED'}\n`);process.exitCode=invalid?64:1;});

#!/usr/bin/env node
'use strict';
const { executeDaily } = require('../../services/ai-review/daily-command');
executeDaily({ argv: process.argv.slice(2) }).then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  const invalid = error.message === 'DAILY_ARGUMENTS_INVALID';
  process.stderr.write(`${invalid ? 'DAILY_ARGUMENTS_INVALID' : 'DAILY_COMMAND_FAILED'}\n`);
  process.exitCode = invalid ? 64 : 1;
});

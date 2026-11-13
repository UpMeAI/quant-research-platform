'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { readDailyInbox } = require('./daily-inbox');
const { runDailyLedgers } = require('./runner');
function cstDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-');
}
function parseArgs(argv, now = new Date()) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--inbox', '--desk-root', '--output-root', '--date'].includes(key) || key in values || !value || value.startsWith('--')) throw Error('DAILY_ARGUMENTS_INVALID');
    values[key] = value;
  }
  for (const key of ['--inbox', '--desk-root']) if (!values[key] || !path.isAbsolute(values[key])) throw Error('DAILY_ARGUMENTS_INVALID');
  if (values['--output-root'] && !path.isAbsolute(values['--output-root'])) throw Error('DAILY_ARGUMENTS_INVALID');
  const period = values['--date'] || cstDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || !Number.isFinite(Date.parse(period)) || new Date(period).toISOString().slice(0, 10) !== period) throw Error('DAILY_ARGUMENTS_INVALID');
  return { inbox: values['--inbox'], deskRoot: values['--desk-root'], root: values['--output-root'] || path.resolve(__dirname, '../../var/ai-review'), period };
}
function budgetFrom(env) {
  const keys = ['AI_REVIEW_TOKENS_PER_CALL', 'AI_REVIEW_TOKENS_PER_DAY', 'AI_REVIEW_TOKENS_PER_MONTH'];
  if (keys.some(k => !/^[1-9]\d*$/.test(env[k] || '') || !Number.isSafeInteger(Number(env[k])))) return null;
  return { perCall: Number(env[keys[0]]), day: Number(env[keys[1]]), month: Number(env[keys[2]]) };
}
async function executeDaily({ argv, env = process.env, now = () => new Date(), validateContract, fetchFn = globalThis.fetch }) {
  const observedAt = now();
  const args = parseArgs(argv, observedAt);
  // Startup configuration is operator supplied, never loaded from an input document.
  if (validateContract === undefined) {
    try { validateContract = require(path.join(args.deskRoot, 'src/validate')).validateContract; } catch { validateContract = null; }
  }
  const validatorState = typeof validateContract === 'function' ? 'AVAILABLE' : 'UNAVAILABLE';
  const input = readDailyInbox({ ...args, nowMs: observedAt.getTime(), validateContract });
  const packs = input.slicePacks.map(pack => input.completeDailyReady ? pack : {
    ...pack,
    inputState: pack.inputState === 'INPUT_STALE' ? 'INPUT_STALE' : 'INPUT_MISSING',
    states: [...pack.states, { ledger: pack.ledger, status: 'INPUT_MISSING', reason: 'COMPLETE_DAILY_COVERAGE_PENDING' }],
  });
  const budget = budgetFrom(env);
  const rows = await runDailyLedgers({ packs, root: args.root, enabled: env.AI_REVIEW_ENABLED === '1', budget,
    keyFile: env.AI_REVIEW_DEEPSEEK_API_KEY_FILE || path.join(os.homedir(), '.config/upmeai/ai-review/deepseek_api_key'),
    fetchFn, now: () => observedAt });
  const manifestFile = path.join(args.root, args.period, 'DAILY.coverage.json');
  const summary = { period: args.period, observedAt: observedAt.toISOString(), completeDailyReady: input.completeDailyReady,
    validatorState, budgetConfigured: budget !== null, manifestFile,
    ledgers: rows.map((row, i) => ({ ledger: row.result.ledger, sliceInputState: input.slicePacks[i].inputState,
      status: row.result.status, inputPackSha256: row.result.inputPackSha256, jsonFile: row.jsonFile, markdownFile: row.markdownFile })) };
  const temporary = `${manifestFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...summary, ruleChanges: input.ruleChanges }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, manifestFile);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return summary;
}
module.exports = { executeDaily, parseArgs, cstDate };

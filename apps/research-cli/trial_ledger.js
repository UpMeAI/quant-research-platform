#!/usr/bin/env node
'use strict';
/**
 * 全局试验台账命令行（研究框架修订 2026-11-10「过拟合控制」§2.4）。写命令只有完成权威能执行（QRP_PRODUCT_MILESTONE_AUTHORITY）。
 * 台账在 $QRP_DATA_DIR/research/（默认 var/ledger/research/，不进 git）：trials.jsonl、data_segments.jsonl、overfit_disclosures.jsonl。
 *
 *   写：
 *   trial_ledger.js register      --spec <specs.json> --registered-by <权威> [--mode PREREGISTERED|UNPLANNED_RUN] [--dry-run true]
 *   trial_ledger.js record        --trial-id <TRL-…> --result <result.json> --registered-by <权威>
 *   trial_ledger.js correct       --trial-id <TRL-…> --result <result.json> --defect-ref <ref> --registered-by <权威>
 *   trial_ledger.js mark-segment  --spec <marks.json> --registered-by <权威>
 *   trial_ledger.js disclose      --spec <disclosure.json> --registered-by <权威> [--dry-run true]
 *   trial_ledger.js disclose-na   --spec <disclosure.json> --registered-by <权威> [--dry-run true]   （DSR、PBO 按协调会话裁定写「不适用」，导入规格修订 4）
 *   trial_ledger.js back-register --master-table /abs/RESEARCH_MASTER_TABLE_….json --master-table-sha256 <64 hex> --registered-by <权威> [--arms /abs/arms.json] [--dry-run true]
 *   读：
 *   trial_ledger.js count         --family <strategy_ref> [--as-of <ISO>]
 *   trial_ledger.js segments      --family <strategy_ref> --from YYYY-MM-DD --to YYYY-MM-DD
 *   trial_ledger.js hash          --rule-config <rule_config.json>      （运行日志 RESEARCH_RUN_LOG_V1 用的 rule_config_hash）
 *   trial_ledger.js trial-id      --family <strategy_ref> --study <study_ref> --label <config_label>   （写进 K2 的台账 id）
 *
 * 没有下单、激活、生产参数写入，也没有 HTTP 写入口。production_effect: NONE。
 */
const fs = require('fs');
const path = require('path');
const ledger = require('../../services/trial-ledger');
const backRegister = require('../../services/trial-ledger/back_register');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const must = (f, ...keys) => { for (const k of keys) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`); };
const json = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const print = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const dry = (f) => f['dry-run'] === 'true';

try {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (command === 'register') {
    must(f, 'spec', 'registered-by');
    for (const row of ledger.register(json(f.spec), { registeredBy: f['registered-by'], mode: f.mode || 'PREREGISTERED', dryRun: dry(f) })) {
      print({ trial_id: row.trial_id, family_id: row.family_id, study_ref: row.study_ref, config_label: row.config_label, role: row.role, rule_config_hash: row.rule_config_hash, replay: Boolean(row.replayHit), dry_run: Boolean(row.dryRun) });
    }
  } else if (command === 'record' || command === 'correct') {
    must(f, 'trial-id', 'result', 'registered-by', ...(command === 'correct' ? ['defect-ref'] : []));
    const row = command === 'record'
      ? ledger.recordResult(f['trial-id'], json(f.result), { registeredBy: f['registered-by'] })
      : ledger.correct(f['trial-id'], json(f.result), { registeredBy: f['registered-by'], defectRef: f['defect-ref'] });
    print({ trial_id: row.trial_id, row_kind: row.row_kind, eval_hash: row.eval_hash, sr_monthly_delta: row.sr_monthly_delta, t_months: row.t_months, segments: row.segments, record_hash: row.record_hash });
  } else if (command === 'mark-segment') {
    must(f, 'spec', 'registered-by');
    for (const row of ledger.markSegments(json(f.spec), { registeredBy: f['registered-by'] })) print({ mark_id: row.mark_id, family_id: row.family_id, from: row.from, to: row.to, label: row.label, shadow_ref: row.shadow_ref });
  } else if (command === 'disclose' || command === 'disclose-na') {
    must(f, 'spec', 'registered-by');
    const write = command === 'disclose' ? ledger.disclose : ledger.discloseNotApplicable;
    const row = write(json(f.spec), { registeredBy: f['registered-by'], dryRun: dry(f) });
    const { inputs: _i, ...shown } = row;
    print(shown);
  } else if (command === 'back-register') {
    must(f, 'master-table', 'master-table-sha256', 'registered-by');
    const out = backRegister.run({ masterTable: f['master-table'], masterTableSha256: f['master-table-sha256'], arms: f.arms ? json(f.arms) : null, registeredBy: f['registered-by'], dryRun: dry(f) });
    print({ dry_run: dry(f), master_table: out.master, rows: out.rows.length, new_rows: out.rows.filter((r) => !r.replayHit).length, segment_marks: out.segmentRows.length, skipped: out.skipped, pairing_review: out.pairing.filter((p) => p.confidence === 'REVIEW') });
    for (const c of out.counts) print({ family_id: c.family_id, n_raw: c.n_raw, n_is_lower_bound: c.n_is_lower_bound, lower_bound_reasons: c.lower_bound_reasons, rows: c.rows, studies: c.studies, by_role: c.by_role });
  } else if (command === 'count') {
    must(f, 'family');
    print(ledger.count(f.family, { asOf: f['as-of'] || null }));
  } else if (command === 'segments') {
    must(f, 'family', 'from', 'to');
    print(ledger.segmentsFor(f.family, f.from, f.to));
  } else if (command === 'hash') {
    must(f, 'rule-config');
    print({ rule_config_hash: ledger.ruleConfigHash(json(f['rule-config'])) });
  } else if (command === 'trial-id') {
    must(f, 'family', 'study', 'label');
    print({ trial_id: ledger.trialIdOf({ family_id: f.family, study_ref: f.study, config_label: f.label }) });
  } else throw new Error(`UNKNOWN_COMMAND:${command || ''}（register | record | correct | mark-segment | disclose | disclose-na | back-register | count | segments | hash | trial-id）`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

'use strict';
/**
 * UX 修订 7 的夹具模型：Q0 + Q1–Q5 全部锁定（Q3 带随机对照，Q4 带只报不判的行，Q5 带参照行与采用建议核对表），
 * 再在测试自己的临时账本里写五条采用决定（与真实一轮的形状相同：Q1、Q4、Q5 采用，Q2、Q3 不采用）。
 * 页面渲染用 vm 跑 index.html 里的脚本（与其他页面测试同一种沙箱）。改版前的金样（golden/a7_fact_sentences_before.json）
 * 就是用这个文件、在 origin/main 的代码与页面上生成的；只有夹具在这里，不写任何真实记录。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dataRoot } = require('./_env');

const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;
const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const adoption = require('../services/research-adoption');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const fx3 = require('./_q3_fixture');
const fx4 = require('./_q4_fixture');
const fx5 = require('./_q5_fixture');

const CASE = cc.CASE_REF;
const STRATEGY = cc.STRATEGY_REF;

let opened = false;
function openCase() {
  if (opened) return;
  opened = true;
  loop.openCase({
    case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
    runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
    baseline: {
      baseline_id: 'BASELINE-A7-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
      source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z',
  });
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function evidence(name) {
  const file = path.join(dataRoot, `a7-adoption-${name}.md`);
  fs.writeFileSync(file, `Owner 决定记录（夹具）${name}\n`);
  return { path: file, sha256: sha(fs.readFileSync(file)) };
}
const decision = (resultId, decided, followUp, name) => ({
  result_id: resultId, decision: decided, follow_up_zh: followUp, decided_by: 'OWNER', owner_words: decided === 'ADOPT' ? '采用' : '不采用',
  decided_at: '2026-10-26T19:00:00+08:00', coordinator_recommendation: { recommendation: decided, reason_zh: '依据见对比卡' }, evidence_ref: evidence(name),
});

/**
 * 锁定 Q0–Q5，写采用记录。decisions：题号 → [决定, 后续]；传 {} 就是一条采用记录都没有（全部待 Owner 决定）。
 */
function setup({ decisions = DEFAULT_DECISIONS } = {}) {
  openCase();
  for (const ledger of [q0.LEDGER(), cc.LEDGER(), adoption.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc0 = fx0.result();
  const lock0 = q0.importBaselineEvaluation(fx0.write(doc0), { registeredBy: AUTHORITY, allowNonActual: true });
  const imp = (file) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true });
  const locks = {
    Q1: imp(fx1.write(fx1.result(doc0, lock0.file_sha256, lock0.result_id))),
    Q2: imp(fx2.write(fx2.result(doc0, lock0.file_sha256, lock0.result_id))),
    Q3: imp(fx3.write(fx3.result(doc0, lock0.file_sha256, lock0.result_id))),
    Q4: imp(fx4.write(fx4.result(doc0, lock0.file_sha256, lock0.result_id))),
  };
  locks.Q5 = imp(fx5.write(fx5.result(doc0, lock0.file_sha256, lock0.result_id, locks.Q4)));
  for (const [question, [decided, followUp]] of Object.entries(decisions)) {
    adoption.recordAdoption(decision(locks[question].result_id, decided, followUp, question), { writtenBy: AUTHORITY, allowNonActual: true });
  }
  return { lock0, locks };
}
const DEFAULT_DECISIONS = Object.freeze({
  Q1: ['ADOPT', '同一规则以 Q5 的组合形式采用'], Q2: ['NOT_ADOPTED', '现行载体不变'], Q3: ['NOT_ADOPTED', '选标的方向在第二轮后再定'],
  Q4: ['ADOPT', '随下一次部署上线，纸面账户执行'], Q5: ['ADOPT', '起草交易规则修订 → Owner 签字 → 实施'],
});

async function modelOf({ locks }) {
  const baseline = q0.buildProjection(q0.headLock(CASE), { allowNonActual: true });
  const cards = Object.values(locks).map((lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref }));
  return workspace.readModel({ strategyRef: STRATEGY, baseline, comparison: cards });
}

function pageScript(file = path.join(__dirname, '..', 'apps', 'research-web', 'index.html')) {
  const page = fs.readFileSync(file, 'utf8');
  return page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
}
/** 在 vm 里跑页面脚本，返回 #workspace 的 HTML 与页头「当前 Desk 策略」的标题。 */
async function render(model, hash, script = pageScript()) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { html: elements.workspace.innerHTML, contextTitle: elements['context-title'].textContent };
}

/** 金样里不稳定的部分（每次导入的锁定时间、临时目录、由它们派生的编号与哈希）换成占位符，其余逐字保留。 */
function stable(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(new RegExp(dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<data>')
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s|：；，<]+/g, '<tmp>')
    .replace(/\b(Q[0-9][A-Za-z0-9]*|ADR)-[0-9a-f]{16}\b/g, '$1-<id>')
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
}

module.exports = { AUTHORITY, CASE, STRATEGY, setup, modelOf, render, pageScript, stable, DEFAULT_DECISIONS };

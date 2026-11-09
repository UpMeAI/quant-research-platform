'use strict';

/**
 * A 股研究封存结论 `ASHARE_SEALED_VERDICT_V1` —— 导入规格 docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md（复盘闭环修订 8 §5）。
 *
 * 校验、取证据、幂等重放、supersede 与海外结论同一套（../overseas-sealed-verdicts，错误码也沿用它的前缀）；台账和锁模式独立。
 * 结论只从封存文件读，不重算、不重新评价；A 股 Q0 账户不在登记表里，也不读。production_effect: NONE。「做」≠ 生产采用。
 */
const path = require('path');
const { dataDir } = require('../../packages/ledger');
const overseas = require('../overseas-sealed-verdicts');

const IMPORT_PROFILE_ID = 'docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md';
const LEDGER = () => path.join(dataDir('research'), 'ashare_sealed_verdicts.jsonl');
const STORE = Object.freeze({
  ledger: LEDGER, lockSchema: 'ASHARE_SEALED_VERDICT_LOCK_V1', recordType: 'ASHARE_SEALED_VERDICT_V1', importProfileId: IMPORT_PROFILE_ID, idPrefix: 'ASV',
  commitSource: 'ashare-v6', commitField: 'ashare_v6_commit', identityOf: (entry) => ({ strategy_ref: entry.strategy_ref, case_ref: null }),
});

const v6 = (commit, file, sha) => Object.freeze({ source: 'ashare-v6', commit, path: file, sha256: sha, ref: `Ashare-V6@${commit.slice(0, 8)}:${file}` });
const coord = (file, sha) => Object.freeze({ source: 'coordinator', path: file, sha256: sha, ref: `artifacts/coordinator/${file}（不在 git 里，按 sha256 绑定）` });

const INDEX = 'INDEX_BOOK';
const R_ETF_2 = v6('d62dde221298c67a3ec079529209b635c490d5d7', 'research/index-grid/r-etf-2/result-r-etf-2.json', 'd45595910e4235b3f2075daccc82aa11f71699e09dd8feff6bf542e39fb17518');
const R_ETF_2_K2 = v6('f19520304755445eb529dc8d5708a09aae644b6a', 'docs/contracts/drafts/ASHARE_V6_ETF_SWING_R_ETF_2_K2_V1.draft.md', 'dace890cce5126e8201d2a51ddbc6429a448d558996f6ded891807dcb2b96ba1');
const rEtf2 = (code, suffix, name) => Object.freeze({ id: `CN-R-ETF-2-${code}`, label_zh: `R-ETF-2 ${name}`, strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-10',
  title_zh: `宽基 ETF 均值回归波段（R-ETF-2，${code}.${suffix}）`, file: R_ETF_2, k2: R_ETF_2_K2, freeze: null, expect: '不做',
  read: Object.freeze({ decision: ['decisions', `${code}.${suffix}`, 'decision'], state: ['decisions', `${code}.${suffix}`, 'reasons'], strength: null, use: 'consequence', text: null }) });

const ENTRIES = Object.freeze([
  { id: 'CN-R-ETF-1', label_zh: 'R-ETF-1', strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-05', title_zh: '宽基 ETF 波动率网格 VG 对现行档位规则 C',
    file: v6('84adf8b97268d59318dda22be5363953e7939b6a', 'research/index-grid/r-etf-1/result-r-etf-1.json', '6eda510cd7dd3aea7ae2f27b83d9e9fb2595aa93c0b69b782473d065f652d3b0'),
    k2: v6('82900c7ec512acb1c99682d70e3a162bc7468939', 'docs/contracts/drafts/ASHARE_V6_ETF_GRID_R_ETF_1_K2_V1.draft.md', '700f8454a76eac367096aefbfc4eaf50241c5091f418c9dbf1cf4bec8aaeb98c'), freeze: null,
    read: Object.freeze({ decision: 'verdict.decision', state: 'verdict.verdict', strength: null, use: 'verdict.consequence', text: null }), expect: '做' },
  { id: 'CN-R-ETF-1-A1', label_zh: 'R-ETF-1 附录 1', strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-05', title_zh: '510880 刹车改看 ETF 全收益（R-ETF-1 附录 1）',
    file: v6('abe9a3fe08b39fe3e6ad94b5fccbf20b31f3e2ec', 'research/index-grid/r-etf-1/result-a1.json', '3759a1835c065ba27e980a594dcbd959c4429451a4ed7f1626e8fe21fe020a89'),
    k2: v6('2b289f48c66c6cff0a7b35d711da41c7ca44caaa', 'docs/contracts/drafts/ASHARE_V6_ETF_GRID_R_ETF_1_K2_ADDENDUM_1.draft.md', '911394d5004eb11d9b098d18a29044f1398c41ca01acdcda802238a6fe86e4f9'), freeze: null,
    read: Object.freeze({ decision: 'decision.decision', state: 'decision.rule', strength: null, use: null, text: null }), expect: '做' },
  rEtf2('510300', 'SH', '沪深 300'), rEtf2('510500', 'SH', '中证 500'), rEtf2('588000', 'SH', '科创 50'), rEtf2('159967', 'SZ', '创成长'), rEtf2('510880', 'SH', '红利'),
  { id: 'CN-PVS-0', label_zh: 'PVS-0', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-10-30', title_zh: '结构分类 PVS0_SWING_ATR_V1 的 2024 年后稳定性',
    file: coord('PVS_0_CONCLUSION_1.md', 'ddeb4ed7f03c5d2015c73f30ce1f7ab8c7309a604d5321780704882c0a61e5ee'),
    k2: coord('PVS_0_K2_V1.draft.md', '738d06827be7baf28550429cf7a672980de3293e960aa0ad29be733077daaf20'), freeze: coord('PVS_0_FREEZE_1.md', 'aa5321e47a0fe8cce313fa6c53391cd8e05136fa3a48af0d185c43aef23f7251'),
    read: Object.freeze({ pattern: '^\\*\\*(做|不做)。\\*\\*', strength_pattern: '按冻结页要求必须写的一句：(.+?)\\*\\*' }), expect: '做' },
]);

const locks = (strategyRef = null) => overseas.locks(strategyRef, STORE);
const stageEvidence = ({ ashareV6Root, artifactsRoot, out, entries = ENTRIES }) => overseas.stageEvidence({ artifactsRoot, out, entries, roots: { 'ashare-v6': ashareV6Root }, importProfileId: IMPORT_PROFILE_ID, manifestKind: 'ASHARE_SEALED_VERDICTS_STAGE_V1' });
const importVerdicts = (evidenceDir, { entries = ENTRIES, ...options } = {}) => overseas.importVerdicts(evidenceDir, { ...options, entries, store: STORE });

module.exports = { ENTRIES, IMPORT_PROFILE_ID, LEDGER, STORE, locks, stageEvidence, importVerdicts };

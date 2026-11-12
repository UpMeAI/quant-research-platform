#!/usr/bin/env node
'use strict';

/**
 * Owner ruling R-1111-ARMS: resolve the 12 REVIEW rows in the pinned v1 K2
 * catalogue without modifying the pinned file.  The output remains an input to
 * trial-ledger back-register; this tool never writes the ledger.
 */
const fs = require('fs');
const crypto = require('crypto');

const V1_SHA256 = '6b189181abaca938884f1d3016af8bb06230b39c0904dcc7c8fe681551af4490';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const arm = (config_label, role, line_start, line_end, k2_quote, rule_config, extra = {}) => ({
  config_label, role, stage: extra.stage || 'BOOK', line_start, line_end, k2_quote,
  ...(rule_config ? { rule_config } : {}),
  ...(extra.notes_zh ? { notes_zh: extra.notes_zh } : {}),
});

const rc = (family, name, value = true) => ({ catalogue_v2: { family, [name]: value } });

function resolvedArms(entry) {
  const family = entry.family_id;
  switch (entry.study_ref) {
    case 'OSV:QS-Q4':
      return [
        arm('D_NOW', 'BASELINE', 224, 228, '**只报不判的风控维度行', rc(family, 'qs_current')),
        arm('PAUSE_LINES_OFF', 'REPORT_ONLY_VARIANT', 228, 228, '`PAUSE_LINES_OFF`', rc(family, 'pause_lines_off')),
        arm('COOLDOWN_30H_0', 'REPORT_ONLY_VARIANT', 229, 229, '`COOLDOWN_30H_0`', rc(family, 'cooldown_30h_0')),
        arm('MAJORS_CLUSTER_CAP_1', 'REPORT_ONLY_VARIANT', 230, 230, '`MAJORS_CLUSTER_CAP_1`', rc(family, 'majors_cluster_cap', 1)),
        arm('KELLY_M_1_REFERENCE', 'REPORT_ONLY_VARIANT', 231, 231, '`KELLY_M_1_REFERENCE`', rc(family, 'kelly_m', 1)),
      ];
    case 'OSV:C17-N6': {
      const switches = [
        ['COOLDOWN_OFF', 'cooldownOff', 137], ['EFFICIENCY_OFF', 'efficiencyOff', 138], ['K5_OFF', 'k5Off', 139],
        ['RSI_BAND_OFF', 'n6.rsiBandOff', 140], ['DIRECTION_GATE_OFF', 'n6.directionGateOff', 141],
        ['REVERSE_COOLDOWN_OFF', 'n6.reverseCooldownOff', 142],
      ];
      const baseline = rc(family, 'n6_baseline');
      return [
        arm('D_NOW', 'BASELINE', 127, 127, '一行都不准入', baseline),
        ...switches.map(([label, key, line]) => arm(label, 'DIAGNOSTIC_ARM', line, line, `\`${key}\``, rc(family, 'n6_single_gate_off', key))),
        // Sealed result 37d8c9d1: no gate was admitted, so the mechanical combination is the baseline.
        arm('COMBINATION_NO_ADMISSION', 'BASELINE', 127, 127, '一行都不准入', baseline),
      ];
    }
    case 'OSV:US5-N5': {
      const grid = [1, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6, 0.5, 0.4, 0.3, 0.25];
      return [
        ...grid.map((m) => arm(`GRID_A_M_${String(m).replace('.', '_')}`, 'REPORT_ONLY_VARIANT', 84, 84, '**网格**', rc(family, 'n5_grid_a_m', m))),
        arm('REPORT_A_M_0_73', 'REPORT_ONLY_VARIANT', 150, 150, '**m = 0.73**', rc(family, 'n5_report_a_m', 0.73)),
        ...[0.75, 0.5, 0.25].map((m) => arm(`REPORT_B_M_${String(m).replace('.', '_')}`, 'REPORT_ONLY_VARIANT', 151, 151, '**★1 (b)**', rc(family, 'n5_report_b_m', m))),
        ...grid.map((m) => arm(`REPORT_C_LINEAR_M_${String(m).replace('.', '_')}`, 'REPORT_ONLY_VARIANT', 152, 152, '**★1 (c)**', rc(family, 'n5_report_c_linear_m', m))),
        // Sealed result 9416bc71 fixed m*=0.50.  It is already one of the 11 grid rows.
        ...[0.5, 1].map((m) => arm(`REPORT_REV1_M_${String(m).replace('.', '_')}`, 'REPORT_ONLY_VARIANT', 154, 154, '**★4 (b)**', rc(family, 'n5_report_rev1_m', m))),
      ];
    }
    case 'OSV:UC-U13-30M': {
      const fills = [
        ['FILL_BAR_INTERP', 71, '**主读法 `FILL_BAR_INTERP`**'],
        ['FILL_BAR_EXTREME', 76, '`FILL_BAR_EXTREME`'],
        ['FILL_BAR_CLOSE', 77, '`FILL_BAR_CLOSE`'],
      ];
      return ['D_TK', 'D_T'].flatMap((book) => fills.map(([fill, line, quote]) =>
        arm(`${book}_${fill}`, 'STRESS', line, line, quote, rc(family, 'u13_30m', { book, fill }))));
    }
    case 'OSV:UC-N1': {
      const baseline = rc(family, 'uc_n1_baseline');
      const e = rc(family, 'uc_n1_levers', ['E']);
      return [
        arm('D_TK', 'BASELINE', 83, 83, '候选 = D_TK', baseline),
        arm('Y_ONLY', 'DIAGNOSTIC_ARM', 80, 80, '**Y 现金停放**', rc(family, 'uc_n1_levers', ['Y'])),
        arm('E_ONLY', 'DIAGNOSTIC_ARM', 81, 81, '**E 趋势内闲置停 1x**', e),
        // Sealed result 0fe7c597 admitted E only; the mechanical combination is the E single.
        arm('COMBINATION_E', 'VERDICT_ARM', 83, 83, '准入一根杠杆', e),
      ];
    }
    case 'OSV:US5-D5-V1': {
      const inherited = (name, value = true) => rc(family, `d5_v1_${name}`, value);
      return [
        arm('C', 'BASELINE', 66, 70, '**C：现行 D。**', inherited('c')),
        arm('T', 'VERDICT_ARM', 72, 79, '**T：同上，只改三处。**', inherited('t')),
        arm('T_NOK', 'REPORT_ONLY_VARIANT', 116, 116, '**T_NOK**', inherited('t_nok')),
        arm('T_3TIER', 'REPORT_ONLY_VARIANT', 117, 117, '**T_3TIER**', inherited('t_3tier')),
        arm('C_COST_15BP', 'STRESS', 118, 118, '**成本行**', inherited('c_cost_15bp')),
        arm('T_COST_15BP', 'STRESS', 118, 118, '**成本行**', inherited('t_cost_15bp')),
        arm('C_SCAN_PLUS_60M', 'STRESS', 119, 119, '**扫描相位 +60 分钟**', inherited('c_scan_plus_60m')),
        arm('T_SCAN_PLUS_60M', 'STRESS', 119, 119, '**扫描相位 +60 分钟**', inherited('t_scan_plus_60m')),
        arm('C_E2_OFF', 'REPORT_ONLY_VARIANT', 131, 131, '**E-2 的影响**', inherited('c_e2_off')),
      ];
    }
    case 'OSV:US5-D5-V2': {
      const inherited = (name, value = true) => rc(family, `d5_v1_${name}`, value);
      const v2 = (name, value = true) => rc(family, `d5_v2_${name}`, value);
      return [
        arm('C_V2', 'BASELINE', 46, 50, '**C：当前 D 中能原样带上的部分**', v2('c')),
        arm('T_V2', 'VERDICT_ARM', 52, 52, '**T：C 加 V1 §3 的三处改动**', v2('t')),
        // §4.1 explicitly inherits these V1 configurations: use identical rule_config hashes.
        arm('T_NOK_V1_INHERITED', 'REPORT_ONLY_VARIANT', 85, 85, 'T_NOK', inherited('t_nok')),
        arm('T_3TIER_V1_INHERITED', 'REPORT_ONLY_VARIANT', 85, 85, 'T_3TIER', inherited('t_3tier')),
        arm('C_COST_15BP_V1_INHERITED', 'STRESS', 85, 85, '15 bp', inherited('c_cost_15bp')),
        arm('T_COST_15BP_V1_INHERITED', 'STRESS', 85, 85, '15 bp', inherited('t_cost_15bp')),
        arm('C_SCAN_PLUS_60M_V1_INHERITED', 'STRESS', 85, 85, '+60 分钟', inherited('c_scan_plus_60m')),
        arm('T_SCAN_PLUS_60M_V1_INHERITED', 'STRESS', 85, 85, '+60 分钟', inherited('t_scan_plus_60m')),
        arm('LADDER_Q6', 'REPORT_ONLY_VARIANT', 86, 86, '**基线阶梯**', v2('ladder', 'Q6')),
        arm('LADDER_E2', 'REPORT_ONLY_VARIANT', 86, 86, '**基线阶梯**', v2('ladder', 'Q6+E2')),
        arm('LADDER_A23', 'REPORT_ONLY_VARIANT', 86, 86, '**基线阶梯**', v2('ladder', 'Q6+E2+A23')),
        arm('LADDER_MIN_OF_BOTH', 'BASELINE', 86, 86, '**基线阶梯**', v2('c')),
      ];
    }
    case 'OSV:C17-X05':
      return [arm('D_CURRENT', 'BASELINE', 95, 95, '**C17**：用现行 D 的账本', rc(family, 'x05_c17_current'))];
    case 'OSV:US5-R8':
    case 'OSV:C17-R8': {
      const base = rc(family, 'r8_baseline');
      return [
        arm('B_K', 'BASELINE', 87, 90, '**B_k（判定基线）**', base),
        arm('B_PROD', 'BASELINE', 87, 90, '**B_prod（生产口径配对）**', rc(family, 'r8_prod_baseline')),
        arm('ENTRY_VETO_OFF', 'DIAGNOSTIC_ARM', 99, 99, '**只关入场否决**', rc(family, 'r8_single_off', 'ENTRY_VETO')),
        arm('MANAGE_OFF', 'DIAGNOSTIC_ARM', 99, 99, '**只关持仓规则**', rc(family, 'r8_single_off', 'MANAGE')),
        arm('T_ALL_OFF', 'VERDICT_ARM', 95, 95, '**臂**：T = B − §3 关掉的规则。', rc(family, 'r8_all_off')),
      ];
    }
    case 'ASV:CN-R-ETF-1-A1': {
      const priorVg = { back_registered_arm: { family_id: family, study_ref: 'ASV:CN-R-ETF-1', config_label: 'VG' } };
      return [
        arm('VG', 'VERDICT_ARM', 40, 40, '重跑 VG', priorVg),
        arm('VG_PRIME', 'VERDICT_ARM', 24, 28, '候选 VG′', rc(family, 'r_etf_1_a1', 'VG_PRIME')),
        arm('SEQUENCE_ONLY', 'DIAGNOSTIC_ARM', 57, 57, '只改序列', rc(family, 'r_etf_1_a1', 'SEQUENCE_ONLY')),
        arm('TIMING_ONLY', 'DIAGNOSTIC_ARM', 57, 57, '只改时点', rc(family, 'r_etf_1_a1', 'TIMING_ONLY')),
        arm('ALL_FIVE_CLOSE', 'REPORT_ONLY_VARIANT', 58, 58, '5 支都改成收盘判定', rc(family, 'r_etf_1_a1', 'ALL_FIVE_CLOSE')),
      ];
    }
    case 'ASV:CN-PVS-0': {
      const parameterRows = [
        ['FROZEN', 86, '冻结值'], ['ZIGZAG_2_0', 87, 'zigzagAtr 2.0'], ['ZIGZAG_3_0', 88, 'zigzagAtr 3.0'],
        ['CONTRACTION_0_25', 89, 'contractionPct 0.25'], ['CONTRACTION_0_45', 90, 'contractionPct 0.45'],
        ['WINDOW_90', 91, 'window 90'], ['WINDOW_150', 92, 'window 150'],
      ];
      return [
        ...parameterRows.map(([name, line, quote]) => arm(name, 'SIGNAL_TEST', line, line, quote, rc(family, 'pvs0_parameter', name), { stage: 'SIGNAL' })),
        arm('ANCHORED_SCAN', 'SIGNAL_TEST', 94, 94, '起点锚在窗口内最高 / 最低价', rc(family, 'pvs0_structure', 'ANCHORED_SCAN'), { stage: 'SIGNAL' }),
        ...[4, 5, 6].map((k) => arm(`BOX_ATR_K${k}`, 'SIGNAL_TEST', 94, 94, 'k = 4、5、6', rc(family, 'pvs0_box_atr_k', k), { stage: 'SIGNAL' })),
      ];
    }
    default:
      return null;
  }
}

function buildDocument(input, sourceSha256) {
  if (sourceSha256 !== V1_SHA256) throw new Error('CATALOGUE_V1_SHA256_MISMATCH');
  if (input.schema !== 'K2_ARMS_CATALOGUE_V1') throw new Error('CATALOGUE_V1_SCHEMA_MISMATCH');
  const studies = input.studies.map((entry) => {
    if (entry.status !== 'REVIEW') return entry;
    const arms = resolvedArms(entry);
    if (!arms) return entry;
    const { review_reason: _review, ...rest } = entry;
    return { ...rest, status: 'OK', ruling: 'R-1111-ARMS', arms };
  });
  return {
    ...input,
    schema: 'K2_ARMS_CATALOGUE_V2',
    supersedes_sha256: V1_SHA256,
    ruling: 'R-1111-ARMS',
    studies,
  };
}

function build(v1Bytes) {
  return buildDocument(JSON.parse(v1Bytes.toString('utf8')), sha256(v1Bytes));
}

function main(argv) {
  const arg = (name) => argv[argv.indexOf(name) + 1];
  const input = arg('--input'); const output = arg('--output');
  if (!input || !output) throw new Error('USAGE: --input <v1.json> --output <v2.json>');
  const doc = build(fs.readFileSync(input));
  fs.writeFileSync(output, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, sha256: sha256(fs.readFileSync(output)), review_left: doc.studies.filter((s) => s.status === 'REVIEW').length })}\n`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { V1_SHA256, build, buildDocument, resolvedArms };

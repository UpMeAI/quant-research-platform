'use strict';

/**
 * 只报不判的行：Q4 的 `report_only_dimensions`（Q4 K2 正文「只报不判的风控维度」与裁定 2），Q5 的 `reference_rows`
 * （Q5 K2「参照行」：原版 D、D+T3、组合对原版）。一个数组，每行报告期末资本、成熟交易、每笔净 R、最大回撤、配对 g（95%）
 * 与改变的笔数，`in_verdict` 必须是 false。登记项的 `report_only` 写明读顶层哪个键（`doc_key`，默认 report_only_dimensions）、
 * 错误码的名字、每行的 g 读哪个字段（`g_key`，默认 g_vs_baseline）以及成熟交易是否可以没有（`n_optional`）。
 *
 * 这几行不进三态、不进采用条件：校验只拒绝两件事——登记项点名的行缺了，或者任何一行没有写 `in_verdict: false`
 * （把只报行说成判定依据）。数字读不出来只让这张卡写「尚未完成」，不拒绝整份文件。不重算任何数字。
 */
const { need, field, ci, finite, isObject, preferZh, E } = require('../common');

const CODES = Object.freeze({ missing: 'REPORT_ONLY_MISSING', row_missing: 'REPORT_ONLY_ROW_MISSING', in_verdict: 'REPORT_ONLY_IN_VERDICT' });
const docKeyOf = (cfg) => cfg.doc_key || 'report_only_dimensions';

function validateReportOnly(entry, doc) {
  const cfg = entry.report_only;
  const codes = { ...CODES, ...(cfg.codes || {}) };
  const key = docKeyOf(cfg);
  const rows = doc[key];
  need(Array.isArray(rows), E(entry, codes.missing));
  for (const spec of cfg.rows) need(rows.some((row) => isObject(row) && row.key === spec.key), E(entry, codes.row_missing), spec.key);
  rows.forEach((row, index) => need(isObject(row) && row.in_verdict === false, E(entry, codes.in_verdict), `${key}[${index}]`));
}

/** 改变的笔数：Q4 的行写 `changed_entries`；Q5 的行写 `changed_vs_baseline {entries, exits, total}`（或组合行的 `changed_vs_reference`），取 total。 */
const changedOf = (row) => {
  if (Number.isInteger(row.changed_entries)) return row.changed_entries;
  const nested = [row.changed_vs_baseline, row.changed_vs_reference].find(isObject);
  return nested && Number.isInteger(nested.total) ? nested.total : null;
};

/** 卡片数据：按登记项的顺序，每行一格；读不出来的数字让整张卡写原因。 */
function card(entry, doc) {
  const cfg = entry.report_only;
  const key = docKeyOf(cfg);
  const rows = doc[key];
  need(Array.isArray(rows), 'MISSING', key);
  return {
    class: cfg.class,
    rows: cfg.rows.map((spec) => {
      const row = rows.find((item) => isObject(item) && item.key === spec.key);
      const where = `${key}.${spec.key}`;
      need(isObject(row), 'MISSING', where);
      const label = preferZh(row, 'label');
      const gKey = spec.g_key || 'g_vs_baseline';
      const g = row[gKey];
      need(isObject(g), 'MISSING', `${where}.${gKey}`);
      return {
        key: spec.key, label: typeof label === 'string' && label.trim() ? label.trim() : spec.label_zh,
        end_capital: field(row, 'end_capital', `${where}.end_capital`),
        n: spec.n_optional && !Number.isInteger(row.n) ? null : field(row, 'n', `${where}.n`),
        mean_R: finite(row.mean_R) ? row.mean_R : null, max_drawdown: finite(row.max_drawdown) ? row.max_drawdown : null,
        g: { value: field(g, 'value', `${where}.${gKey}.value`), ci_95: ci(g.ci_95, `${where}.${gKey}.ci_95`) },
        ...(spec.g_against_zh ? { g_against_zh: spec.g_against_zh } : {}),
        changed_entries: changedOf(row), in_verdict: false,
      };
    }),
    note_zh: cfg.note_zh,
    ...(cfg.g_label_zh ? { g_label_zh: cfg.g_label_zh } : {}),
    ...(cfg.changed_label_zh ? { changed_label_zh: cfg.changed_label_zh } : {}),
  };
}

module.exports = { validateReportOnly, card };

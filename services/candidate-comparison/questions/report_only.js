'use strict';

/**
 * 只报不判的风控维度行 `report_only_dimensions`（Q4 K2 正文「只报不判的风控维度」与裁定 2）：一个数组，每行对原版报告
 * 期末资本、成熟交易、每笔净 R、最大回撤、配对 g（95%）与改变的入场数，`in_verdict` 必须是 false。
 *
 * 这几行不进三态、不进采用条件：校验只拒绝两件事——登记项点名的行缺了，或者任何一行没有写 `in_verdict: false`
 * （把只报行说成判定依据）。数字读不出来只让这张卡写「尚未完成」，不拒绝整份文件。不重算任何数字。
 */
const { need, field, ci, finite, isObject, preferZh, E } = require('../common');

function validateReportOnly(entry, doc) {
  const cfg = entry.report_only;
  const rows = doc.report_only_dimensions;
  need(Array.isArray(rows), E(entry, 'REPORT_ONLY_MISSING'));
  for (const spec of cfg.rows) need(rows.some((row) => isObject(row) && row.key === spec.key), E(entry, 'REPORT_ONLY_ROW_MISSING'), spec.key);
  rows.forEach((row, index) => need(isObject(row) && row.in_verdict === false, E(entry, 'REPORT_ONLY_IN_VERDICT'), `report_only_dimensions[${index}]`));
}

/** 卡片数据：按登记项的顺序，每行一格；读不出来的数字让整张卡写原因。 */
function card(entry, doc) {
  const cfg = entry.report_only;
  const rows = doc.report_only_dimensions;
  need(Array.isArray(rows), 'MISSING', 'report_only_dimensions');
  return {
    class: cfg.class,
    rows: cfg.rows.map((spec) => {
      const row = rows.find((item) => isObject(item) && item.key === spec.key);
      const where = `report_only_dimensions.${spec.key}`;
      need(isObject(row), 'MISSING', where);
      const label = preferZh(row, 'label');
      const g = row.g_vs_baseline;
      need(isObject(g), 'MISSING', `${where}.g_vs_baseline`);
      return {
        key: spec.key, label: typeof label === 'string' && label.trim() ? label.trim() : spec.label_zh,
        end_capital: field(row, 'end_capital', `${where}.end_capital`), n: field(row, 'n', `${where}.n`),
        mean_R: finite(row.mean_R) ? row.mean_R : null, max_drawdown: finite(row.max_drawdown) ? row.max_drawdown : null,
        g: { value: field(g, 'value', `${where}.g_vs_baseline.value`), ci_95: ci(g.ci_95, `${where}.g_vs_baseline.ci_95`) },
        changed_entries: Number.isInteger(row.changed_entries) ? row.changed_entries : null, in_verdict: false,
      };
    }),
    note_zh: cfg.note_zh,
  };
}

module.exports = { validateReportOnly, card };

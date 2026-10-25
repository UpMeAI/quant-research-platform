'use strict';

/**
 * Desk 系统策略目录的只读适配层。
 *
 * 策略范围、角色、生命周期和名称都来自 portfolio-desk 的既有权威模块；
 * 本层只把这些事实与 QRP case 关联起来，不读取账本内容、不重算策略、不写 Desk。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DESK_ROOT = path.resolve(__dirname, '../../../portfolio-desk');
const SOURCE_PATHS = Object.freeze({
  books: 'src/operation-review.js',
  lifecycle: 'src/panel/read-model.js',
  glossary: 'src/panel/glossary.js',
});

const MARKET_LABELS = Object.freeze({ CN: 'A 股', US: '美股', CRYPTO: '加密' });
const MODE_LABELS = Object.freeze({ PAPER: '模拟运行', SHADOW: '影子观察' });
const LIFECYCLE_LABELS = Object.freeze({
  OPEN: '运行中',
  RUN_OFF: '收尾中（停止新开仓）',
  CLOSED: '已关闭',
  NOT_YET_EFFECTIVE: '尚未生效',
});

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireFresh(file) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return require(resolved);
}

function loadSource({ deskRoot = process.env.QRP_DESK_ROOT || DEFAULT_DESK_ROOT } = {}) {
  const root = path.resolve(deskRoot);
  const files = Object.fromEntries(Object.entries(SOURCE_PATHS).map(([key, relative]) => [key, path.join(root, relative)]));
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) throw new Error(`DESK_STRATEGY_SOURCE_MISSING:${file}`);
  }
  // 每次投影都重新读取三个权威导出，避免目录内容已更新而 require cache 与文件 hash 不一致。
  const operation = requireFresh(files.books);
  const lifecycle = requireFresh(files.lifecycle);
  const glossary = requireFresh(files.glossary);
  return {
    books: operation.OPERATION_REVIEW_BOOKS,
    effectiveFrom: lifecycle.EFFECTIVE_FROM,
    closedBooks: lifecycle.CLOSED_BOOKS,
    closedBook: lifecycle.closedBook,
    runOffBook: lifecycle.runOffBook,
    notYetEffective: lifecycle.notYetEffective,
    bookLifecycle: lifecycle.bookLifecycle,
    explain: glossary.explain,
    provenance: {
      root,
      files: Object.entries(files).map(([key, file]) => ({ key, file, sha256: sha256File(file) })),
    },
  };
}

function lifecycleFor(source, strategyRef, role, asOf) {
  if (typeof source.bookLifecycle === 'function') return source.bookLifecycle(null, strategyRef, asOf);
  if (source.notYetEffective?.(strategyRef, asOf)) return { state: 'NOT_YET_EFFECTIVE' };
  if (source.closedBook?.(strategyRef, asOf, [])) return { state: 'CLOSED' };
  if (source.runOffBook?.(strategyRef, asOf, [])) return { state: 'RUN_OFF' };
  return { state: role === 'SHADOW' ? 'OPEN' : 'OPEN' };
}

function researchState(strategyRef, cases) {
  const currentCases = cases.filter((item) => item.strategy_ref === strategyRef);
  const baselineCases = cases.filter((item) => item.baseline?.strategy_ref === strategyRef);
  const links = currentCases.flatMap((item) => item.links || []);
  let code = 'NOT_CONNECTED';
  let label = '尚未接入 Research';
  if (currentCases.length) {
    if (links.some((item) => item.result_hash || item.result_ref)) {
      code = 'RESULT_LOCKED'; label = '已有锁定研究结论';
    } else if (links.length) {
      code = 'RESEARCHING'; label = '研究进行中';
    } else {
      code = 'CONNECTED'; label = '已接入，暂无研究问题';
    }
  } else if (baselineCases.length) {
    code = 'FROZEN_BASELINE'; label = '作为冻结基线关联';
  }
  return {
    code, label, case_count: currentCases.length, baseline_case_count: baselineCases.length,
    link_count: links.length,
    case_refs: currentCases.map((item) => item.case_id),
    baseline_case_refs: baselineCases.map((item) => item.case_id),
  };
}

function buildDirectory({ source, cases = [], asOf }) {
  const requiredObjects = ['books', 'effectiveFrom', 'closedBooks'];
  const requiredFunctions = ['explain', 'notYetEffective', 'closedBook', 'runOffBook', 'bookLifecycle'];
  const missing = [
    ...requiredObjects.filter((key) => !source || !source[key] || typeof source[key] !== 'object'),
    ...requiredFunctions.filter((key) => !source || typeof source[key] !== 'function'),
  ];
  if (missing.length) throw new Error(`DESK_STRATEGY_SOURCE_INVALID:${missing.join(',')}`);
  const strategies = [];
  for (const [market, books] of Object.entries(source.books)) {
    for (const [strategyRef, role] of Object.entries(books)) {
      if (role === 'USER_MONITOR_ONLY') continue;
      const lifecycleFact = lifecycleFor(source, strategyRef, role, asOf);
      const lifecycle = lifecycleFact.state;
      const isHistory = lifecycle === 'CLOSED' || lifecycle === 'RUN_OFF';
      const research = researchState(strategyRef, cases);
      strategies.push({
        strategy_ref: strategyRef,
        market_ref: market,
        market_label: MARKET_LABELS[market] || '未知市场',
        name: source.explain(strategyRef),
        role,
        mode_label: MODE_LABELS[role] || '模式待解释',
        lifecycle: {
          code: role === 'SHADOW' && lifecycle === 'OPEN' ? 'OBSERVING' : lifecycle,
          label: lifecycleFact.finalPending ? '已关闭（最终交接待确认）'
            : role === 'SHADOW' && lifecycle === 'OPEN' ? '研究观察中' : (LIFECYCLE_LABELS[lifecycle] || '生命周期未知'),
          group: isHistory ? 'HISTORY' : 'CURRENT',
          final_delivery_pending: lifecycleFact.finalPending === true,
        },
        research,
        effective_from: source.effectiveFrom?.[strategyRef] || null,
        successor_ref: source.closedBooks?.[strategyRef]?.successor || null,
        technical: { strategy_ref: strategyRef },
      });
    }
  }
  return strategies;
}

function readModel({ cases = [], asOf = new Date().toISOString(), deskRoot, source } = {}) {
  try {
    const loaded = source || loadSource({ deskRoot });
    const strategies = buildDirectory({ source: loaded, cases, asOf });
    const current = strategies.filter((item) => item.lifecycle.group === 'CURRENT');
    const history = strategies.filter((item) => item.lifecycle.group === 'HISTORY');
    return {
      state: 'AVAILABLE',
      state_label: 'Desk 策略目录已连接',
      as_of: asOf,
      current,
      history,
      strategies,
      counts: {
        current: current.length,
        history: history.length,
        research_connected: strategies.filter((item) => item.research.code !== 'NOT_CONNECTED').length,
      },
      provenance: loaded.provenance || null,
    };
  } catch (error) {
    return {
      state: 'UNAVAILABLE',
      state_label: 'Desk 策略目录暂时不可读取',
      as_of: asOf,
      current: [], history: [], strategies: [],
      counts: { current: null, history: null, research_connected: null },
      error: String(error.message || error),
      provenance: null,
    };
  }
}

module.exports = {
  DEFAULT_DESK_ROOT, SOURCE_PATHS, MARKET_LABELS, MODE_LABELS, LIFECYCLE_LABELS,
  loadSource, buildDirectory, researchState, readModel,
};

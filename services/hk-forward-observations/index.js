'use strict';

/**
 * 已在 HK 运行、尚未导入 QRP 的前向影子（UX 修订 3 C5）。
 *
 * 事实来源是 `config/hk_forward_observations.v1.json`：登记名称、起始日、运行位置和输出文件，不含任何结果数字。
 * 页面据此写「已在 HK 运行，尚未导入」，不能写「尚无前向观察」。条目的 `qrp_shadow_ref` 一旦指向
 * shadow-control 里真实存在的运行，状态改读 QRP 台账；指向不存在的运行则失败关闭为「导入引用无效」。
 */
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'config', 'hk_forward_observations.v1.json');

function load(file = CONFIG) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.contract !== 'HK_FORWARD_OBSERVATIONS_V1' || !Array.isArray(doc.items)) throw new Error('HK_FORWARD_OBSERVATIONS_CONTRACT_INVALID');
  for (const item of doc.items) {
    for (const key of ['id', 'label', 'started_on', 'location', 'output_ref']) {
      if (typeof item[key] !== 'string' || !item[key]) throw new Error(`HK_FORWARD_OBSERVATION_MISSING:${item.id || '?'}:${key}`);
    }
    if (!Array.isArray(item.applies_to) || !item.applies_to.length) throw new Error(`HK_FORWARD_OBSERVATION_MISSING:${item.id}:applies_to`);
  }
  return doc;
}

/** 某策略的 HK 前向观察条目；`shadowRuns` 是 QRP shadow-control 的运行列表（用于识别已导入）。 */
function forStrategy(strategyRef, { shadowRuns = [], file = CONFIG } = {}) {
  let doc;
  try { doc = load(file); } catch (error) {
    return { state: 'UNAVAILABLE', reason: String(error.message || error), verified_at: null, items: [] };
  }
  const known = new Set(shadowRuns.map((run) => run.shadow_id));
  return {
    state: 'AVAILABLE', reason: null, verified_at: doc.verified_at,
    items: doc.items.filter((item) => item.applies_to.includes(strategyRef)).map((item) => {
      const imported = item.qrp_shadow_ref ? known.has(item.qrp_shadow_ref) : false;
      const brokenRef = Boolean(item.qrp_shadow_ref) && !imported;
      return {
        id: item.id, name: item.label, started_on: item.started_on, location: item.location,
        import_state: brokenRef ? 'IMPORT_REF_INVALID' : (imported ? 'IMPORTED' : 'RUNNING_ON_HK_NOT_IMPORTED'),
        state_label: brokenRef ? '导入引用无效：QRP 里找不到这条前向观察'
          : imported ? '已导入 QRP，状态读 QRP 台账' : '已在 HK 运行，尚未导入',
        qrp_shadow_ref: item.qrp_shadow_ref || null, output_ref: item.output_ref, acceptance_ref: item.acceptance_ref || null,
      };
    }),
  };
}

module.exports = { CONFIG, load, forStrategy };

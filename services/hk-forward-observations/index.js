'use strict';

/**
 * 已在 HK 运行、尚未导入 QRP 的前向影子（UX 修订 3 C5）。
 *
 * 事实来源是 `config/hk_forward_observations.v1.json`：登记名称、起始日、运行位置和输出文件，不含任何结果数字。
 * 页面据此写「已在 HK 运行，尚未导入」，不能写「尚无前向观察」。条目的 `qrp_shadow_ref` 一旦指向
 * shadow-control 里真实存在的运行，状态改读 QRP 台账；指向不存在的运行则失败关闭为「导入引用无效」。
 *
 * 条目按策略分组（`strategies.<来源键>.items`）；一条策略读哪一组，由它的策略档案的 `forward_observation_source_key` 决定。
 * 未登记的策略读不到任何一组（NOT_REGISTERED），页面不会把别的策略的前向观察放到它下面。
 */
const fs = require('fs');
const path = require('path');

const profiles = require('../strategy-profiles');

const CONFIG = path.join(__dirname, '..', '..', 'config', 'hk_forward_observations.v1.json');

function load(file = CONFIG) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const groups = doc.strategies;
  if (doc.contract !== 'HK_FORWARD_OBSERVATIONS_V1' || !groups || typeof groups !== 'object'
    || !Object.values(groups).every((group) => group && Array.isArray(group.items))) throw new Error('HK_FORWARD_OBSERVATIONS_CONTRACT_INVALID');
  for (const item of Object.values(groups).flatMap((group) => group.items)) {
    for (const key of ['id', 'label', 'started_on', 'location', 'output_ref']) {
      if (typeof item[key] !== 'string' || !item[key]) throw new Error(`HK_FORWARD_OBSERVATION_MISSING:${item.id || '?'}:${key}`);
    }
    if (!Array.isArray(item.applies_to) || !item.applies_to.length) throw new Error(`HK_FORWARD_OBSERVATION_MISSING:${item.id}:applies_to`);
  }
  return doc;
}

/** 某策略的 HK 前向观察条目；`shadowRuns` 是 QRP shadow-control 的运行列表（用于识别已导入）。 */
function forStrategy(strategyRef, { shadowRuns = [], file = CONFIG } = {}) {
  const profile = profiles.get(strategyRef);
  if (!profile) return { state: 'NOT_REGISTERED', reason: 'STRATEGY_PROFILE_NOT_REGISTERED', verified_at: null, items: [] };
  let doc;
  try { doc = load(file); } catch (error) {
    return { state: 'UNAVAILABLE', reason: String(error.message || error), verified_at: null, items: [] };
  }
  const known = new Set(shadowRuns.map((run) => run.shadow_id));
  const items = ((doc.strategies[profile.forward_observation_source_key] || {}).items || []).filter((item) => item.applies_to.includes(strategyRef));
  // 条目自己写了核对日（增补 2 §5.3：加密轮次的影子在 2026-10-27 另行只读核对）时，取这组里最晚的一个；都没写时用文件的核对日
  const itemDates = items.map((item) => item.verified_at).filter((value) => typeof value === 'string' && value);
  return {
    state: 'AVAILABLE', reason: null, verified_at: itemDates.length ? itemDates.sort().pop() : doc.verified_at,
    items: items.map((item) => {
      const imported = item.qrp_shadow_ref ? known.has(item.qrp_shadow_ref) : false;
      const brokenRef = Boolean(item.qrp_shadow_ref) && !imported;
      return {
        id: item.id, name: item.label, started_on: item.started_on, location: item.location,
        import_state: brokenRef ? 'IMPORT_REF_INVALID' : (imported ? 'IMPORTED' : 'RUNNING_ON_HK_NOT_IMPORTED'),
        state_label: brokenRef ? '导入引用无效：QRP 里找不到这条前向观察'
          : imported ? '已导入 QRP，状态读 QRP 台账' : '已在 HK 运行，尚未导入',
        forward_stream: item.forward_stream || null, // 对应对比结果 forward 行的 stream（B／S），页面据此写「已在 Q1 结果中读入 N 行」
        qrp_shadow_ref: item.qrp_shadow_ref || null, output_ref: item.output_ref, acceptance_ref: item.acceptance_ref || null,
        ...(item.verified_at ? { verified_at: item.verified_at } : {}),
      };
    }),
  };
}

module.exports = { CONFIG, load, forStrategy };

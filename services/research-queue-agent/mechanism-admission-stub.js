'use strict';
/**
 * MECHANISM_ADMISSION_PROGRAM_V1（RF1118 C4）的桩：Q2 只把 NEW 机制想法排成 WAITING_EXTERNAL:MECHANISM_ADMISSION 的提案。
 * 准入本身（写 mechanism_admissions.jsonl、classified_by: AI_REVIEW_CARD、登记表加载合并）不在这个 PR；这里故意没有 admit()。
 */
const { isNew, err } = require('./routing');

function proposeAdmission(idea) {
  if (!isNew(idea)) throw err('MECHANISM_PROPOSAL_NOT_NEW', idea.idea_id);
  const n = idea.mechanism.NEW;
  return {
    schema: 'MECHANISM_PROPOSAL_V1', idea_id: idea.idea_id, market: idea.market, week_id: idea.week_id,
    classified_by: 'AI_REVIEW_CARD', state: 'WAITING_EXTERNAL:MECHANISM_ADMISSION',
    proposed: { mechanism_id: n.proposed_id, title_zh: n.title_zh, description_zh: n.description_zh, layer: n.layer, decision_point: n.decision_point },
    card_sha256: idea.card_sha256, fact_pack_sha256: idea.fact_pack_sha256, fact_ids: idea.fact_ids,
  };
}

/** 桩的登记表合并：已准入的机制 id 并进视野用的 id 集合（真实合并是 C4 的登记表加载器）。 */
const mergeAdmittedIds = (ids, admissions) => new Set([...ids, ...admissions.map((a) => a.mechanism_id)]);

module.exports = { proposeAdmission, mergeAdmittedIds };

'use strict';

/**
 * 研究与实盘一致性合同 RESEARCH_LIVE_PARITY_V1 的签字页绑定与生效时刻。做法同 ../research-framework-amendment-20261112-addendum-1。
 *
 * Owner 2026-11-17 00:23 CST 在协调窗口签字（签字页 SIGNATURE_1，全部 ★ 取默认）。签字页与它签的文本都在协调会话目录，不在 git 里，
 * 按 path + sha256 绑定。EFFECTIVE_FROM 是签字页写出的唯一常量：G-PARITY 从这里读，不另写（★3 (a)：只管以后，此前冻结的 K2 不追溯）。
 */
const SHA64 = /^[0-9a-f]{64}$/;

const SIGNATURE = Object.freeze({
  path: 'artifacts/coordinator/RESEARCH_LIVE_PARITY_V1_SIGNATURE_1.md',
  sha256: 'f0fe8e5c38a5e7d78dd101601480e1565ccfdede4c2d1971c6fc3b3a56531bce',
  state: 'SIGNED',
  texts: Object.freeze([
    Object.freeze({ id: 'SIGNED_TEXT', path: 'artifacts/coordinator/RESEARCH_LIVE_PARITY_V1.signed.ceb35505.md',
      sha256: 'ceb3550579372d77c3ae5697981a884a459d27aa707c2c2d0b07ecfe336eb27e' }),
  ]),
});
const EFFECTIVE_FROM = '2026-11-17T00:24:00+08:00';

/** 签字页是否已绑定：签字页与它签的文本都有 sha256，state 为 SIGNED。 */
const isBound = (s = SIGNATURE) => Boolean(s) && SHA64.test(s.sha256 || '') && s.state === 'SIGNED'
  && Array.isArray(s.texts) && s.texts.length > 0 && s.texts.every((t) => SHA64.test((t && t.sha256) || ''));

module.exports = { SIGNATURE, EFFECTIVE_FROM, isBound };

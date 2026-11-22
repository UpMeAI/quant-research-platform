'use strict';

/**
 * 独立验证器的权限（W20，PLAN V1.1 修订 1 §2.2–§2.3）。
 *
 * 主体分三类：生成方（mining-generator、review-agent）、受信的运行主体（verifier、holdout-scorer）、其余（未知，一律拒绝）。
 *   WRITE_FILE              验证器代码与配置、判定表与门槛、留出段数据目录：没有任何运行时主体能写（改它们只走评审过的提交）。→ VERIFIER_WRITE_REFUSED
 *   MODIFY_DECISION_TABLE   已冻结的判定表与门槛：没有任何运行时主体能改。→ FROZEN_TABLE_CHANGE_REFUSED
 *   REQUEST_METRICS         生成方只能要挖掘段与验证段的数；留出段、验证段之后、读不出段名的一律拒绝；要判定细节也拒绝（只给通过与否加原因码）。→ HOLDOUT_METRICS_REFUSED
 *   READ_FILE               留出段数据目录只有 holdout-scorer 能读。→ HOLDOUT_DIR_READ_REFUSED
 *   HOLDOUT_READ            只有 holdout-scorer；每个冻结候选（按候选 sha256）只一次，授权时追加一行台账。→ HOLDOUT_SECOND_READ_REFUSED
 * 配置文件的字节按下面的 CONFIG_SHA256 钉住：被改一个字节，验证器拒绝运行（VERIFIER_CONFIG_PIN_MISMATCH）。
 * 进程级的锁在 ./process-lock（写只许输出目录，读不许进留出段目录）；OS 级的证据在 tools/independent-verifier-host-evidence.js。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, append, read, now } = require('../../packages/ledger');
const { canonicalJson } = require('../trial-ledger');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'independent_verifier.v1.json');
/** 配置的 canonicalJson 的 sha256；改配置必须同时改这一行，两处都在评审过的提交里。 */
const CONFIG_SHA256 = '835775c57a3cd110b3811404d8b041b46f40bae0efb45ed28254dc32c92c83a6';
const ACTIONS = Object.freeze(['WRITE_FILE', 'MODIFY_DECISION_TABLE', 'REQUEST_METRICS', 'REQUEST_VERDICT_DETAIL', 'READ_FILE', 'HOLDOUT_READ']);

class VerifierAuthorityError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const refuse = (code, detail) => { throw new VerifierAuthorityError(code, detail); };

function loadConfig(bytes = null) {
  const buf = bytes || fs.readFileSync(CONFIG_FILE);
  let cfg;
  try { cfg = JSON.parse(buf.toString('utf8')); } catch { return refuse('VERIFIER_CONFIG_PIN_MISMATCH', 'NOT_JSON'); }
  if (crypto.createHash('sha256').update(canonicalJson(cfg)).digest('hex') !== CONFIG_SHA256) refuse('VERIFIER_CONFIG_PIN_MISMATCH');
  return Object.freeze(cfg);
}

function real(p) {
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(String(p));
      tail.push(path.basename(cur)); cur = up;
    }
  }
}
const within = (target, root) => { const t = real(target); const r = real(root); const rel = path.relative(r, t); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function holdoutDirsOf(ctx) {
  if (Array.isArray(ctx.holdoutDirs)) return ctx.holdoutDirs;
  return (process.env.QRP_HOLDOUT_DATA_DIRS || '').split(path.delimiter).filter(Boolean);
}
const ledgerFileOf = (ctx) => ctx.ledgerFile || path.join(dataDir('research'), 'verifier_holdout_reads.jsonl');
const KIND = 'VERIFIER_HOLDOUT_READ_V1';

/** 这个候选（按冻结的 sha256）的留出段读取记录。 */
const holdoutReadsOf = (candidateSha256, ctx = {}) => read(ledgerFileOf(ctx)).filter((r) => r.kind === KIND && r.candidate_sha256 === candidateSha256);

/**
 * @param {{principal: string, action: string, target?: string, segment?: string, candidateId?: string, candidateSha256?: string}} req
 * @param {{repoRoot?: string, holdoutDirs?: string[], ledgerFile?: string, config?: object}} [ctx]
 * @returns {{allowed: true}} 拒绝时抛 VerifierAuthorityError
 */
function authorize(req, ctx = {}) {
  const cfg = ctx.config || loadConfig();
  const root = ctx.repoRoot || ROOT;
  const { principal, action } = req || {};
  const generator = cfg.generatorPrincipals.includes(principal);
  if (!(generator || cfg.trustedPrincipals.includes(principal))) refuse('VERIFIER_PRINCIPAL_UNKNOWN', String(principal || ''));
  if (!ACTIONS.includes(action)) refuse('VERIFIER_ACTION_UNKNOWN', String(action));
  const inList = (rels) => rels.some((r) => within(req.target, path.join(root, r)));
  const holdout = () => holdoutDirsOf(ctx).some((d) => within(req.target, d));
  switch (action) {
    case 'WRITE_FILE':
      if (inList([...cfg.protected.verifier, ...cfg.protected.decisionTables]) || holdout()) refuse('VERIFIER_WRITE_REFUSED', path.basename(String(req.target)));
      return { allowed: true };
    case 'MODIFY_DECISION_TABLE':
      if (inList(cfg.protected.decisionTables)) refuse('FROZEN_TABLE_CHANGE_REFUSED', path.basename(String(req.target)));
      return { allowed: true };
    case 'REQUEST_METRICS':
      if (generator && !cfg.generatorMetricSegments.includes(req.segment)) refuse('HOLDOUT_METRICS_REFUSED', String(req.segment));
      return { allowed: true };
    case 'REQUEST_VERDICT_DETAIL':
      if (generator) refuse('HOLDOUT_METRICS_REFUSED', 'VERDICT_DETAIL');
      return { allowed: true };
    case 'READ_FILE':
      if (holdout() && principal !== cfg.holdoutScorerPrincipal) refuse('HOLDOUT_DIR_READ_REFUSED', path.basename(String(req.target)));
      return { allowed: true };
    default: // HOLDOUT_READ
      if (principal !== cfg.holdoutScorerPrincipal) refuse('HOLDOUT_DIR_READ_REFUSED', 'HOLDOUT_READ');
      if (!/^[0-9a-f]{64}$/.test(req.candidateSha256 || '')) refuse('VERIFIER_CANDIDATE_SHA_REQUIRED');
      if (holdoutReadsOf(req.candidateSha256, ctx).length) refuse('HOLDOUT_SECOND_READ_REFUSED', req.candidateSha256.slice(0, 8));
      return { allowed: true };
  }
}

/** 授权并记账：留出段每个冻结候选只能走通一次。 */
function grantHoldoutRead({ principal, candidateSha256, candidateId }, ctx = {}) {
  authorize({ principal, action: 'HOLDOUT_READ', candidateSha256, candidateId }, ctx);
  append(ledgerFileOf(ctx), { kind: KIND, candidate_sha256: candidateSha256, candidate_id: candidateId || null, principal, at: now() });
  return { allowed: true };
}

module.exports = { CONFIG_FILE, CONFIG_SHA256, ACTIONS, VerifierAuthorityError, loadConfig, authorize, grantHoldoutRead, holdoutReadsOf, holdoutDirsOf, internals: { within } };

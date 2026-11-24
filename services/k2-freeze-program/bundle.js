'use strict';

/**
 * Deterministic input-bundle builder for the AI_PREREG agent (RF1118 V10, AQ-38). Whitelist by kind; forbidden sources by path segment,
 * extension and canary content, checked after resolving symlinks; the bundle bytes and sha depend only on the inputs and the injected time.
 * Excluded by construction: sealed account series and results, QRP sealed_research_results, holdout vaults, mining out/, race and paper results, production DBs.
 */
const fs = require('fs');
const path = require('path');
const { fail, need, sha256, prettyJson, isCstStamp } = require('./common');
const { TOKEN_PREFIX } = require('./canary');

const BUILDER = 'K2_BUNDLE_BUILDER_V1';
const KINDS = Object.freeze(['CANDIDATE_FACTS', 'MECHANISM_REGISTER', 'ROUTING_READING', 'FACTOR_LIBRARY_IDS', 'DATA_CATALOG', 'K2_TEMPLATE', 'DECISION_TABLE_TEMPLATES', 'POWER_OUTPUTS', 'RISK_RULES', 'PROMOTION_TERMS_STAR']);
const MARKETS = Object.freeze(['CN_A', 'US_EQUITY', 'CRYPTO']);
const FORBIDDEN_SEGMENT = /^(sealed[\w.-]*|holdout[\w.-]*|vault|race[\w.-]*|paper[\w.-]*|production[\w.-]*|prod|restore_[\w.-]*|out|\.git|\.env[\w.-]*)$/i;
const FORBIDDEN_EXT = /\.(sql|dump|pgdump|sqlite|db)$/i;

function forbidden(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.some((p) => FORBIDDEN_SEGMENT.test(p)) || FORBIDDEN_EXT.test(rel);
}

/**
 * @param {{market: string, root: string, files: {kind: string, path: string}[], outDir: string, builtAt: string}} spec  paths relative to root
 * @returns {{builder: string, sha256: string, dir: string, manifest: object}}
 */
function build({ market, root, files, outDir, builtAt }) {
  need(MARKETS.includes(market), 'BUNDLE_MARKET_INVALID', String(market));
  need(isCstStamp(builtAt), 'BUNDLE_BUILT_AT_INVALID', String(builtAt));
  need(typeof root === 'string' && Array.isArray(files) && files.length, 'BUNDLE_SPEC_INVALID');
  const realRoot = fs.realpathSync(root);
  const rows = [];
  for (const f of files) {
    need(KINDS.includes(f.kind), 'BUNDLE_KIND_NOT_ALLOWED', String(f.kind));
    const abs = path.resolve(realRoot, f.path);
    const relGiven = path.relative(realRoot, abs);
    need(!relGiven.startsWith('..') && !path.isAbsolute(relGiven), 'BUNDLE_SOURCE_FORBIDDEN', `outside root: ${f.path}`);
    need(!forbidden(relGiven), 'BUNDLE_SOURCE_FORBIDDEN', relGiven);
    let real;
    try { real = fs.realpathSync(abs); } catch { fail('BUNDLE_SOURCE_MISSING', relGiven); }
    const relReal = path.relative(realRoot, real);
    need(!relReal.startsWith('..') && !forbidden(relReal), 'BUNDLE_SOURCE_FORBIDDEN', `resolved: ${relReal}`);
    const bytes = fs.readFileSync(real);
    need(!bytes.includes(TOKEN_PREFIX), 'BUNDLE_CANARY_FOUND', relGiven);
    rows.push({ kind: f.kind, path: relGiven.split(path.sep).join('/'), sha256: sha256(bytes), bytes: bytes.length, content: bytes });
  }
  rows.sort((a, b) => (a.kind + a.path < b.kind + b.path ? -1 : a.kind + a.path > b.kind + b.path ? 1 : 0));
  need(new Set(rows.map((r) => r.kind + r.path)).size === rows.length, 'BUNDLE_SPEC_INVALID', 'duplicate file');
  const manifest = { schema: 'K2_BUNDLE_V1', builder: BUILDER, market, built_at: builtAt, files: rows.map(({ kind, path: p, sha256: s, bytes }) => ({ kind, path: p, sha256: s, bytes })) };
  const manifestBytes = prettyJson(manifest);
  const dir = path.join(outDir, 'bundle');
  need(!fs.existsSync(dir) || !fs.readdirSync(dir).length, 'BUNDLE_OUTDIR_NOT_EMPTY', dir);
  for (const r of rows) {
    const dest = path.join(dir, r.kind, r.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, r.content, { mode: 0o444 });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), manifestBytes, { mode: 0o444 });
  return { builder: BUILDER, sha256: sha256(manifestBytes), dir, manifest };
}

module.exports = { BUILDER, KINDS, MARKETS, build, internals: { forbidden } };

'use strict';

// Dataset registry guard (G2 of AUDIT_DATA_FLOW_DUPLICATES_2026-10-20, adopted by the coordinator 2026-10-20 as the
// data-flow acceptance A1–A10). One registry (data/registry/datasets.v1.json, owned here in Cycle Atlas) names one owner
// per dataset. This scanner reads a repository's code and reports every place where a system that is NOT the owner
// collects or produces a registered dataset. A finding passes only when the registry lists it, either as a standing
// exception (TRADING_PATH / RECONCILIATION_ONLY / INTERIM with an expiry) or as a known violation that names the
// migration step removing it. A known violation that no longer matches anything is stale and fails too, so the list
// can only shrink. Built-in modules only: V6 (node:test), smartflow (jest) and Cycle Atlas (node --test) load this same
// file, pinned by sha256.

const fs = require('node:fs');
const path = require('node:path');

const EXCEPTION_CLASSES = Object.freeze(['TRADING_PATH', 'RECONCILIATION_ONLY', 'INTERIM']);
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.py', '.sh', '.zsh', '.bash']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wrangler', '__pycache__', 'fixtures']);
// A host written in code: a URL (https://host/…), or a quoted bare host with a known public suffix.
const URL_HOST = /\b(?:https?:)?\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[/:?#'"`\s)]|$)/gi;
const BARE_HOST = /['"`]((?:[a-z0-9-]+\.)+(?:com|cn|org|gov|net|io|jp|edu|uk|de|eu|kr|tw|int))['"`]/gi;
// A crontab line: five schedule fields, then a command that runs a repository script.
const CRON_LINE = /^\s*(?:[\d*/,-]+\s+){5}.*?(?:<node>|\b(?:node|bash|zsh|sh|python3?))\s+(?:\S*\/)?(scripts\/[\w./-]+)/;

function toPosix(file) { return file.split(path.sep).join('/'); }

function walk(root, relative, out) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(root, path.join(relative, entry.name), out);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) out.push(toPosix(path.join(relative, entry.name)));
  }
  return out;
}

function hostsIn(text) {
  const hosts = new Set();
  for (const match of text.matchAll(URL_HOST)) hosts.add(match[1].toLowerCase().replace(/\.$/, ''));
  for (const match of text.matchAll(BARE_HOST)) hosts.add(match[1].toLowerCase());
  return hosts;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hostMatches = (host, signature) => host === signature || host.endsWith(`.${signature}`);

/** What in `text` identifies dataset `dataset` (its signatures), or [] when nothing does. */
function signatureHits(text, hosts, signatures = {}) {
  const hits = [];
  for (const signature of signatures.hosts || []) {
    for (const host of hosts) if (hostMatches(host, signature)) hits.push(`host:${host}`);
  }
  for (const name of signatures.apiNames || []) {
    if (new RegExp(`['"\`]${escapeRegExp(name)}['"\`]`).test(text)) hits.push(`api:${name}`);
  }
  for (const name of signatures.callNames || []) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(text)) hits.push(`call:${name}`);
  }
  for (const token of signatures.tokens || []) {
    if (text.includes(token)) hits.push(`token:${token}`);
  }
  return [...new Set(hits)].toSorted();
}

/** `pattern` is a repo-relative path, or a directory prefix ending in `/**`. */
function pathMatches(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

/**
 * A CONSUMER exception is the owner side reading a private-side system's TRADING_PATH data as read-only aggregates
 * (SG-2, 2026-10-21): the private side stays the only collector. It cites a registered dataset owned by another system,
 * whose consumer entry for this system names the exception's paths and says READ_ONLY_AGGREGATES.
 */
function consumerProblems(registry, system, exception) {
  if (!exception.dataset) return [`${system}: CONSUMER exception has no dataset`];
  const dataset = (registry.datasets || []).find((item) => item.id === exception.dataset);
  if (!dataset) return [`${system}: CONSUMER exception cites an unregistered dataset ${exception.dataset}`];
  if (dataset.owner === system) return [`${system}: CONSUMER exception cites ${dataset.id}, which is owned by ${system}`];
  const problems = [];
  if (dataset.basis !== 'TRADING_PATH') problems.push(`${dataset.id}: a CONSUMER exception covers TRADING_PATH data only`);
  const consumer = (dataset.consumers || []).find((item) => item.system === system);
  if (!consumer) return [...problems, `${system}: CONSUMER exception cites ${dataset.id}, which has no consumer entry for ${system}`];
  if (consumer.access !== 'READ_ONLY_AGGREGATES') problems.push(`${dataset.id}: consumer ${system} access must be READ_ONLY_AGGREGATES`);
  for (const file of exception.paths || []) {
    if (!(consumer.paths || []).some((pattern) => pathMatches(file, pattern))) problems.push(`${system}: CONSUMER exception path ${file} is not a consumer path of ${dataset.id}`);
  }
  return problems;
}

function validateRegistry(registry, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  if (registry?.schemaVersion !== 'DATASET_REGISTRY_V1') problems.push('schemaVersion is not DATASET_REGISTRY_V1');
  const systems = new Set(Object.keys(registry?.systems || {}));
  const ids = new Set();
  for (const dataset of registry?.datasets || []) {
    if (!dataset.id || ids.has(dataset.id)) problems.push(`dataset id missing or repeated: ${dataset.id}`);
    ids.add(dataset.id);
    if (!systems.has(dataset.owner)) problems.push(`${dataset.id}: owner ${dataset.owner} is not a registered system`);
    for (const exception of dataset.exceptions || []) {
      if (!systems.has(exception.system)) problems.push(`${dataset.id}: exception system ${exception.system} unknown`);
      if (exception.system === dataset.owner) problems.push(`${dataset.id}: the owner needs no exception`);
      if (!EXCEPTION_CLASSES.includes(exception.class)) problems.push(`${dataset.id}: exception class ${exception.class} is not one of ${EXCEPTION_CLASSES.join('/')}`);
      if (!exception.reason) problems.push(`${dataset.id}: exception for ${exception.system} has no reason`);
      if (exception.class === 'INTERIM') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn || '')) problems.push(`${dataset.id}: INTERIM exception for ${exception.system} has no expiresOn`);
        else if (exception.expiresOn < today) problems.push(`${dataset.id}: INTERIM exception for ${exception.system} expired on ${exception.expiresOn}`);
      }
      if (!(exception.paths || []).length) problems.push(`${dataset.id}: exception for ${exception.system} lists no paths`);
    }
    // A consumer entry may carry an expiry (a read that stops when the consumer has its own source, e.g. DF-P1); the guard fails after it.
    for (const consumer of dataset.consumers || []) {
      if (consumer.expiresOn === undefined) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(consumer.expiresOn)) problems.push(`${dataset.id}: consumer ${consumer.system} has an expiresOn that is not a date`);
      else if (consumer.expiresOn < today) problems.push(`${dataset.id}: consumer ${consumer.system} expired on ${consumer.expiresOn}`);
    }
    for (const violation of dataset.knownViolations || []) {
      if (!systems.has(violation.system)) problems.push(`${dataset.id}: known violation system ${violation.system} unknown`);
      if (!violation.removedBy || !violation.auditRef) problems.push(`${dataset.id}: known violation for ${violation.system} needs removedBy and auditRef`);
      if (!(violation.paths || []).length) problems.push(`${dataset.id}: known violation for ${violation.system} lists no paths`);
    }
  }
  for (const [system, spec] of Object.entries(registry?.systems || {})) {
    for (const entry of spec.ignore || []) if (!entry.path || !entry.reason) problems.push(`${system}: ignore entries need a path and a reason`);
    for (const exception of spec.forbiddenUpstream?.exceptions || []) {
      if (!['RECONCILIATION_ONLY', 'INTERIM', 'CONSUMER'].includes(exception.class) || !exception.reason || !(exception.paths || []).length) {
        problems.push(`${system}: forbiddenUpstream exceptions are RECONCILIATION_ONLY or INTERIM (or CONSUMER of a registered V6-owned dataset), with a reason and paths`);
      }
      if (exception.class === 'CONSUMER') problems.push(...consumerProblems(registry, system, exception));
      // A temporary private-side read (e.g. a publisher of V6 output until Cycle Atlas produces it itself) carries a date.
      if (exception.class === 'INTERIM') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn || '')) problems.push(`${system}: forbiddenUpstream INTERIM exception has no expiresOn`);
        else if (exception.expiresOn < today) problems.push(`${system}: forbiddenUpstream INTERIM exception expired on ${exception.expiresOn}`);
      }
    }
    for (const violation of spec.forbiddenUpstream?.knownViolations || []) {
      if (!violation.removedBy || !violation.auditRef || !(violation.paths || []).length) problems.push(`${system}: forbiddenUpstream known violation needs removedBy, auditRef and paths`);
    }
  }
  return problems;
}

/**
 * Scan one repository for one system.
 * @returns {{ findings, uncovered, stale, cronUncovered, unusedExceptions, upstream, upstreamUncovered, upstreamStale }}
 */
function scanRepository({ root, system, registry }) {
  const spec = registry.systems?.[system];
  if (!spec) throw new Error(`DATASET_REGISTRY_UNKNOWN_SYSTEM:${system}`);
  // `ignore`: files that name a host or token without collecting it (a routing table, a host registry), each with a reason.
  const ignored = (spec.ignore || []).map((entry) => entry.path);
  const files = (spec.scanRoots || []).flatMap((relative) => walk(root, relative, []))
    .filter((file) => !ignored.some((pattern) => pathMatches(file, pattern)));
  const texts = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const findings = [];
  for (const [file, text] of texts) {
    const hosts = hostsIn(text);
    for (const dataset of registry.datasets || []) {
      if (dataset.owner === system) continue;
      const hits = signatureHits(text, hosts, dataset.signatures);
      if (hits.length) findings.push({ datasetId: dataset.id, owner: dataset.owner, file, hits });
    }
  }
  const mine = (entry) => entry.system === system;
  const coverOf = (finding) => {
    const dataset = registry.datasets.find((item) => item.id === finding.datasetId);
    const exception = (dataset.exceptions || []).filter(mine).find((entry) => entry.paths.some((p) => pathMatches(finding.file, p)));
    if (exception) return { kind: 'EXCEPTION', class: exception.class };
    const violation = (dataset.knownViolations || []).filter(mine).find((entry) => entry.paths.some((p) => pathMatches(finding.file, p)));
    if (violation) return { kind: 'KNOWN_VIOLATION', removedBy: violation.removedBy, auditRef: violation.auditRef };
    return null;
  };
  const covered = findings.map((finding) => ({ ...finding, cover: coverOf(finding) }));
  const uncovered = covered.filter((finding) => !finding.cover);
  // Every known-violation path must still match a finding of its dataset: when a step removes a collector, its entry goes.
  const stale = [];
  const unusedExceptions = [];
  for (const dataset of registry.datasets || []) {
    for (const violation of (dataset.knownViolations || []).filter(mine)) {
      for (const pattern of violation.paths) {
        if (!findings.some((finding) => finding.datasetId === dataset.id && pathMatches(finding.file, pattern))) stale.push(`${dataset.id}: ${pattern}`);
      }
    }
    for (const exception of (dataset.exceptions || []).filter(mine)) {
      for (const pattern of exception.paths) {
        if (!findings.some((finding) => finding.datasetId === dataset.id && pathMatches(finding.file, pattern))) unusedExceptions.push(`${dataset.id}: ${pattern}`);
      }
    }
  }
  // Cron lines anywhere in the system's cron roots that run a non-owner collector: the line's file must be listed as a
  // runtime of that collector's registry entry (exception or known violation).
  const cronFiles = (spec.cronRoots || []).flatMap((relative) => walkAll(root, relative, []));
  const cronUncovered = [];
  for (const file of cronFiles) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = CRON_LINE.exec(line);
      if (!match) return;
      const script = match[1];
      for (const finding of covered.filter((item) => item.file === script)) {
        const dataset = registry.datasets.find((item) => item.id === finding.datasetId);
        const entries = [...(dataset.exceptions || []), ...(dataset.knownViolations || [])].filter(mine);
        if (!entries.some((entry) => (entry.runtimes || []).includes(file))) cronUncovered.push(`${finding.datasetId}: ${file}:${index + 1} runs ${script}`);
      }
    });
  }
  // Owner side: the owner must not read the private side (IC-A13: data flows from the public side to the desk only).
  const upstream = [];
  const forbidden = spec.forbiddenUpstream || {};
  for (const [file, text] of texts) {
    const hits = (forbidden.tokens || []).filter((token) => text.includes(token));
    if (hits.length) upstream.push({ file, hits });
  }
  const upstreamKnown = forbidden.knownViolations || [];
  // A read-only check that compares against the private side, never a production input, may be listed as an exception.
  const upstreamAllowed = [...upstreamKnown, ...(forbidden.exceptions || [])];
  const upstreamUncovered = upstream.filter((item) => !upstreamAllowed.some((entry) => entry.paths.some((p) => pathMatches(item.file, p))));
  const upstreamStale = upstreamKnown.flatMap((entry) => entry.paths.filter((p) => !upstream.some((item) => pathMatches(item.file, p))));
  return { findings: covered, uncovered, stale, cronUncovered, unusedExceptions, upstream, upstreamUncovered, upstreamStale };
}

/** Every text file (for cron lines in docs and ops). */
function walkAll(root, relative, out) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walkAll(root, path.join(relative, entry.name), out);
    } else if (entry.isFile() && /\.(md|txt|cron|sh|conf|service|timer|ya?ml|plist)$|(^|\/)cron\.d\//.test(entry.name)) out.push(toPosix(path.join(relative, entry.name)));
  }
  return out;
}

/** One-line report for a failing assertion. */
function describe(result) {
  const lines = [];
  for (const item of result.uncovered) lines.push(`UNREGISTERED ${item.datasetId} (owner ${item.owner}): ${item.file} [${item.hits.join(', ')}]`);
  for (const item of result.stale) lines.push(`STALE known violation (remove it from the registry): ${item}`);
  for (const item of result.cronUncovered) lines.push(`CRON not listed as a runtime: ${item}`);
  for (const item of result.upstreamUncovered) lines.push(`PRIVATE-SIDE DEPENDENCY: ${item.file} [${item.hits.join(', ')}]`);
  for (const item of result.upstreamStale) lines.push(`STALE forbiddenUpstream known violation: ${item}`);
  return lines.join('\n');
}

module.exports = { EXCEPTION_CLASSES, describe, hostsIn, pathMatches, scanRepository, signatureHits, validateRegistry };

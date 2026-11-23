'use strict';

/**
 * R-7 static scan: find code that reaches the label table. Producer (Ashare-V6, smartflow) and desk code must not read it (contract section 7.1 LB-2, section 8.2 R-7).
 * The scan is a token search over a source tree; it reads files and nothing else. Point it at a checkout, or at `git archive` output of a branch.
 */
const fs = require('fs');
const path = require('path');

const TOKEN = /panel[-_]labels|PANEL_LABEL/i;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.json', '.sql', '.sh', '.yml', '.yaml']);

/** @returns {{file: string, line: number, text: string}[]} */
function findLabelTableReaders(root) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((text, i) => { if (TOKEN.test(text)) hits.push({ file: full, line: i + 1, text: text.trim().slice(0, 160) }); });
    }
  };
  walk(root);
  return hits;
}

module.exports = { TOKEN, findLabelTableReaders };

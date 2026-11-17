'use strict';

/**
 * 导出规格 rev 2 的 CSV（Postgres `\copy … WITH (FORMAT csv, HEADER true)`）：逗号分隔、双引号包字段、字段里的引号写两次；
 * 不加引号的空字段是 NULL（→ null），加了引号的空字段是空串（→ ''）。一行一个对象（键 = 表头）。
 * 按块读（不把整个文件读进一个字符串：日线一个文件可到 GB 级），读的同时算 sha256，读完返回（调用方拿它核 SHA256SUMS）。
 * 只读文件，不写任何东西，不连网络。
 */
const fs = require('fs');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const CHUNK = 1 << 23;
const QUOTE = 34; const COMMA = 44; const LF = 10; const CR = 13;

/**
 * @param {string} file
 * @param {(row: object) => void} onRow
 * @returns {{rows: number, sha256: string}}
 */
function forEachCsvRow(file, onRow) {
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const dec = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(CHUNK);
  let header = null; let row = []; let field = ''; let quoted = false;
  let state = 0; // 0 字段外或不带引号的字段里；1 引号里；2 引号里刚看到一个引号
  let rows = 0;
  const endField = () => { row.push(!quoted && field === '' ? null : field); field = ''; quoted = false; };
  const endRow = () => {
    endField();
    if (header === null) header = row.map((h) => (h === null ? '' : h));
    else if (!(row.length === 1 && row[0] === null)) {
      if (row.length !== header.length) throw new Error(`MINE_DATA_CSV_ROW_WIDTH:${file}:${rows + 2}`);
      const o = {}; for (let k = 0; k < header.length; k += 1) o[header[k]] = row[k];
      rows += 1; onRow(o);
    }
    row = [];
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n) hash.update(buf.subarray(0, n));
      const s = n ? dec.write(buf.subarray(0, n)) : dec.end();
      let start = 0;
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (state === 1) { if (c === QUOTE) { field += s.slice(start, i); state = 2; } continue; }
        if (state === 2) {
          if (c === QUOTE) { field += '"'; state = 1; start = i + 1; continue; }
          state = 0; start = i; // 引号结束，落到下面按普通字符处理
        }
        if (c === QUOTE && field === '' && start === i) { quoted = true; state = 1; start = i + 1; continue; }
        if (c === COMMA) { field += s.slice(start, i); endField(); start = i + 1; continue; }
        if (c === LF) {
          let piece = s.slice(start, i);
          if (piece.endsWith('\r')) piece = piece.slice(0, -1);
          field += piece; endRow(); start = i + 1; continue;
        }
        if (c === CR && i + 1 < s.length && s.charCodeAt(i + 1) !== LF) throw new Error(`MINE_DATA_CSV_BARE_CR:${file}`);
      }
      if (state !== 2) field += s.slice(start);
      if (!n) break;
    }
    if (state === 1) throw new Error(`MINE_DATA_CSV_UNTERMINATED_QUOTE:${file}`);
    if (field !== '' || row.length || quoted) endRow();
  } finally { fs.closeSync(fd); }
  return { rows, sha256: hash.digest('hex') };
}

module.exports = { forEachCsvRow };

'use strict';
/**
 * UX 修订 7 J5.2「不丢信息」用的事实句抽取：把页面脚本渲染出的 HTML 拆成一条条事实句（去空白、去重）。
 *
 * 规则（改版前后用同一份，金样与比对才可比）：
 *   - 块级元素（段落、列表项、标题、摘要行、说明、单元格容器等）各成一句，块内的行内文字（strong、span、code、a、button…）连在一起；
 *   - 表格按行成句：同一行的单元格用「 | 」连接（一行就是一条事实：哪一项、哪些数）；
 *   - 定义列表 dt + dd 成一句「dt：dd」；
 *   - 状态标签（.pill）与导航栏里的链接各自成句，不和相邻的标签连在一起；
 *   - 实体解码、空白压成一个空格、去掉空句；最后去重（重复的标题与句子只算一次）。
 */
const BLOCK = new Set(['p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'caption', 'div', 'section', 'article',
  'header', 'nav', 'main', 'table', 'thead', 'tbody', 'details', 'small', 'time', 'dl']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const clean = (text) => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]).replace(/\s+/g, ' ').trim();

function factSentences(html) {
  const out = [];
  let buffer = '';
  let row = null; let cell = null; let term = null;
  const spans = [];
  let nav = 0;
  const flush = () => {
    const text = clean(buffer); buffer = '';
    if (!text) return;
    if (cell !== null) { cell += (cell ? ' ' : '') + text; return; }
    out.push(text);
  };
  const tokens = String(html).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').split(/(<[^>]*>)/);
  for (const token of tokens) {
    if (!token.startsWith('<')) { buffer += token; continue; }
    const match = /^<(\/?)([a-zA-Z0-9]+)/.exec(token);
    if (!match) continue;
    const closing = match[1] === '/'; const tag = match[2].toLowerCase();
    if (tag === 'br') { buffer += ' '; continue; }
    if (tag === 'tr') { flush(); if (!closing) row = []; else if (row) { if (row.some(Boolean)) out.push(row.join(' | ')); row = null; } continue; }
    if (tag === 'td' || tag === 'th') {
      if (!closing) { flush(); cell = ''; } else { const before = cell; cell = null; const rest = clean(buffer); buffer = ''; const text = [before, rest].filter(Boolean).join(' '); if (row) row.push(text); else if (text) out.push(text); }
      continue;
    }
    if (tag === 'dt' || tag === 'dd') {
      if (!closing) { flush(); continue; }
      const text = clean(buffer); buffer = '';
      if (tag === 'dt') { if (term !== null && term) out.push(term); term = text; } else { out.push(term ? `${term}：${text}` : text); term = null; }
      continue;
    }
    if (tag === 'span') {
      if (!closing) { const isPill = /class="pill\b/.test(token); spans.push(isPill); if (isPill) flush(); } else if (spans.pop()) flush();
      continue;
    }
    if (tag === 'nav') nav += closing ? -1 : 1;
    if (BLOCK.has(tag) || (tag === 'a' && nav > 0)) flush();
  }
  flush();
  if (term) out.push(term);
  return [...new Set(out)];
}

module.exports = { factSentences };

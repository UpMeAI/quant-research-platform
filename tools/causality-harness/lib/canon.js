'use strict';

/**
 * 输出的规范写法（★4 (a) 逐字节相等）：数值写成 IEEE 754 双精度的 16 位十六进制，-0、NaN 的位型都保留；
 * 字符串按 JSON 转义；对象键排序；undefined 与缺键不同。两个读数的规范串相等，才算相等。
 */
const scratch = new DataView(new ArrayBuffer(8));
const hexOf = (n) => { scratch.setFloat64(0, n); let s = ''; for (let i = 0; i < 8; i += 1) s += scratch.getUint8(i).toString(16).padStart(2, '0'); return s; };

function canon(v) {
  if (v === null) return 'n';
  if (v === undefined) return 'u';
  switch (typeof v) {
    case 'boolean': return v ? 'b:1' : 'b:0';
    case 'number': return `d:${hexOf(v)}`;
    case 'bigint': return `i:${v.toString()}`;
    case 'string': return `s:${JSON.stringify(v)}`;
    case 'object': break;
    default: throw new Error(`UNSUPPORTED_OUTPUT_TYPE:${typeof v}`);
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v, canon).join(',')}]`;
  if (v instanceof Date) return `t:${hexOf(v.getTime())}`;
  if (v instanceof Map) return `M{${[...v].map(([k, x]) => `${canon(k)}=${canon(x)}`).sort().join(',')}}`;
  if (v instanceof Set) return `S[${[...v].map(canon).sort().join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

module.exports = { canon };

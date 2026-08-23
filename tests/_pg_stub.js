'use strict';
/** 最小 pg 桩:仅供反分叉守卫加载 Ashare-V5 纯函数模块;任何真实连接尝试都显式抛错。 */
class Pool {
  constructor() { throw new Error('PG_STUB_NO_CONNECTION(反分叉守卫只比对纯函数,不应建立数据库连接)'); }
}
module.exports = { Pool };

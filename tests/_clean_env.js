'use strict';
/** 子进程（执行器命令行、run.sh）的环境：去掉测试口子 QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION（执行器启动时拒绝带着它）。 */
module.exports = () => { const { QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION: _seam, ...rest } = process.env; return rest; };

'use strict';
/** 测试隔离:每个测试进程独立临时数据目录(必须在任何平台模块 require 前加载)。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-test-'));
module.exports = { dataRoot: process.env.QRP_DATA_DIR };

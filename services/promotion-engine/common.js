'use strict';

/** Shared helpers of PROMOTION_ENGINE_V1. Reuses the K2 freeze program's helpers; no clock, no network, no model call in this directory. */
const k2 = require('../k2-freeze-program/common');

const CST_DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const isInt = (v) => Number.isInteger(v);
const isDate = (v) => typeof v === 'string' && CST_DATE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00+08:00`));

class EngineError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

module.exports = { ...k2, num, round6, isInt, isDate, EngineError, clone };

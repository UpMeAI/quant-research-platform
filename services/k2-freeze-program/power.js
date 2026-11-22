'use strict';

/**
 * Deterministic power tool for K2_FREEZE_PROGRAM_V1 (V3). Closed form for a two-sided test of a standardized difference:
 *   n = ceil( ((z(1 - alpha/2) + z(power)) / effect_size_sd)^2 )
 * z() is the Acklam rational approximation of the normal quantile (relative error about 1e-9), rounded to 6 decimals so the result does not
 * depend on the last ulp of the platform's math library.
 */
const { fail } = require('./common');

const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function zInv(p) {
  if (typeof p !== 'number' || !(p > 0 && p < 1)) fail('PREREG_POWER_INPUT_INVALID', `p=${p}`);
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  return round6(x);
}

/** @param {{effect_size_sd: number, alpha: number, power_target: number}} input */
function requiredN({ effect_size_sd: effect, alpha, power_target: target } = {}) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!num(effect) || !(effect > 0)) fail('PREREG_POWER_INPUT_INVALID', `effect_size_sd=${effect}`);
  if (!num(alpha) || !(alpha > 0 && alpha < 1)) fail('PREREG_POWER_INPUT_INVALID', `alpha=${alpha}`);
  if (!num(target) || !(target > 0 && target < 1)) fail('PREREG_POWER_INPUT_INVALID', `power_target=${target}`);
  const z = zInv(round6(1 - alpha / 2)) + zInv(target);
  return Math.ceil(round6((z / effect) ** 2));
}

/** Error rates are fixed by the program, never chosen by the drafter (plan-coord review of #142). */
const FIXED_RATES = Object.freeze({ alpha: 0.05, power_target: 0.8, ci_level: 0.95 });

/** The power tool's output for one effect size at the fixed rates: what the bundle carries as POWER_OUTPUTS and what a draft must copy. */
function outputs(effectSizeSd) {
  const n = requiredN({ effect_size_sd: effectSizeSd, alpha: FIXED_RATES.alpha, power_target: FIXED_RATES.power_target });
  return { effect_size_sd: effectSizeSd, alpha: FIXED_RATES.alpha, power_target: FIXED_RATES.power_target, n_required: n };
}

module.exports = { zInv, requiredN, FIXED_RATES, outputs };

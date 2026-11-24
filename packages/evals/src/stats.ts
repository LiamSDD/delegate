export class InsufficientDataError extends Error {
  override readonly name = "InsufficientDataError";
}

function assertFinite(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value)))
    throw new RangeError("Samples must be finite numbers");
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new InsufficientDataError("mean needs at least one sample");
  assertFinite(values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2)
    throw new InsufficientDataError("sample variance needs at least two samples");
  assertFinite(values);
  const shift = values[0] ?? 0;
  let sum = 0;
  let sumSquares = 0;
  for (const value of values) {
    sum += value - shift;
    sumSquares += (value - shift) ** 2;
  }
  return Math.max(0, (sumSquares - (sum * sum) / values.length) / (values.length - 1));
}

export function sampleStd(values: readonly number[]): number {
  return Math.sqrt(sampleVariance(values));
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = 0.9999999999998099;
  LANCZOS.forEach((coefficient, index) => {
    sum += coefficient / (shifted + index + 1);
  });
  const t = shifted + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 500; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + even * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + even / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + odd * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + odd / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return result;
}

export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError("Degrees of freedom must be positive");
  if (t === Number.POSITIVE_INFINITY) return 1;
  if (t === Number.NEGATIVE_INFINITY) return 0;
  const tail = 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

export function tCritical(df: number, confidence = 0.95): number {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError("Confidence must be in (0, 1)");
  const target = 1 - (1 - confidence) / 2;
  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < target) high *= 2;
  for (let iteration = 0; iteration < 200 && high - low > 1e-12; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, df) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const ACKLAM_A = [
  -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
  2.506628277459239,
];
const ACKLAM_B = [
  -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
];
const ACKLAM_C = [
  -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const ACKLAM_D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];

function polynomial(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("Probability must be in (0, 1)");
  const lowTail = 0.02425;
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return polynomial(ACKLAM_C, q) / (polynomial(ACKLAM_D, q) * q + 1);
  }
  if (p > 1 - lowTail) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -polynomial(ACKLAM_C, q) / (polynomial(ACKLAM_D, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (polynomial(ACKLAM_A, r) * q) / (polynomial(ACKLAM_B, r) * r + 1);
}

export interface ConfidenceInterval {
  mean: number;
  lower: number;
  upper: number;
  halfWidth: number;
  n: number;
  confidence: number;
}

export function meanConfidenceInterval(
  values: readonly number[],
  confidence = 0.95,
): ConfidenceInterval {
  const center = mean(values);
  const halfWidth =
    (tCritical(values.length - 1, confidence) * sampleStd(values)) / Math.sqrt(values.length);
  return {
    mean: center,
    lower: center - halfWidth,
    upper: center + halfWidth,
    halfWidth,
    n: values.length,
    confidence,
  };
}

export interface ProportionInterval {
  rate: number;
  lower: number;
  upper: number;
  n: number;
  confidence: number;
}

export function wilsonInterval(
  successes: number,
  n: number,
  confidence = 0.95,
): ProportionInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || successes > n) {
    throw new RangeError("Successes must be an integer between 0 and n");
  }
  if (n === 0) throw new InsufficientDataError("Wilson interval needs at least one trial");
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const rate = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (rate + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / denominator;
  return {
    rate,
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === n ? 1 : Math.min(1, center + margin),
    n,
    confidence,
  };
}

export interface WelchResult {
  t: number;
  df: number;
  pValue: number;
  meanA: number;
  meanB: number;
}

export function welchTTest(a: readonly number[], b: readonly number[]): WelchResult {
  const meanA = mean(a);
  const meanB = mean(b);
  const termA = sampleVariance(a) / a.length;
  const termB = sampleVariance(b) / b.length;
  const standardError = Math.sqrt(termA + termB);
  if (standardError === 0) {
    const same = meanA === meanB;
    return {
      t: same ? 0 : Math.sign(meanA - meanB) * Number.POSITIVE_INFINITY,
      df: a.length + b.length - 2,
      pValue: same ? 1 : 0,
      meanA,
      meanB,
    };
  }
  const t = (meanA - meanB) / standardError;
  const df = (termA + termB) ** 2 / (termA ** 2 / (a.length - 1) + termB ** 2 / (b.length - 1));
  const pValue = Math.min(1, 2 * studentTCdf(-Math.abs(t), df));
  return { t, df, pValue, meanA, meanB };
}

export interface RegressionOptions {
  alpha?: number;
  higherIsBetter?: boolean;
}

export interface ScoreComparison {
  baselineMean: number;
  candidateMean: number;
  worsening: number;
  threshold: number;
  pValue: number;
  alpha: number;
  regression: boolean;
}

export function compareScores(
  baseline: readonly number[],
  candidate: readonly number[],
  threshold: number,
  options: RegressionOptions = {},
): ScoreComparison {
  if (!(threshold >= 0)) throw new RangeError("Threshold must be non-negative");
  const alpha = options.alpha ?? 0.05;
  const higherIsBetter = options.higherIsBetter ?? true;
  const test = welchTTest(baseline, candidate);
  const worsening = higherIsBetter ? test.meanA - test.meanB : test.meanB - test.meanA;
  return {
    baselineMean: test.meanA,
    candidateMean: test.meanB,
    worsening,
    threshold,
    pValue: test.pValue,
    alpha,
    regression: worsening > threshold && test.pValue < alpha,
  };
}

export function isRegression(
  baseline: readonly number[],
  candidate: readonly number[],
  threshold: number,
  options: RegressionOptions = {},
): boolean {
  return compareScores(baseline, candidate, threshold, options).regression;
}

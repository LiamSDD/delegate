import { describe, expect, it } from "vitest";

import {
  InsufficientDataError,
  compareScores,
  isRegression,
  mean,
  meanConfidenceInterval,
  normalQuantile,
  sampleStd,
  studentTCdf,
  tCritical,
  welchTTest,
  wilsonInterval,
} from "./stats";

describe("mean and sampleStd", () => {
  it("computes known values", () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(sampleStd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
    expect(sampleStd([1, 1, 1])).toBe(0);
  });

  it("refuses empty or single-sample input", () => {
    expect(() => mean([])).toThrow(InsufficientDataError);
    expect(() => sampleStd([1])).toThrow(InsufficientDataError);
  });
});

describe("Student t distribution", () => {
  it("matches the closed-form CDF for df = 1 and df = 2", () => {
    for (const t of [-3, -0.5, 0, 0.7, 2, 10]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 10);
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 10);
    }
  });

  it.each([
    [1, 12.706],
    [2, 4.303],
    [3, 3.182],
    [4, 2.776],
    [5, 2.571],
    [6, 2.447],
    [7, 2.365],
    [8, 2.306],
    [9, 2.262],
    [10, 2.228],
    [15, 2.131],
    [20, 2.086],
    [30, 2.042],
    [60, 2.0],
    [120, 1.98],
  ])("two-sided 95%% critical value for df = %i is %f", (df, expected) => {
    expect(tCritical(df)).toBeCloseTo(expected, 3);
  });

  it("supports other confidence levels and approaches the normal quantile", () => {
    expect(tCritical(10, 0.99)).toBeCloseTo(3.169, 3);
    expect(tCritical(5, 0.9)).toBeCloseTo(2.015, 3);
    expect(tCritical(1e6)).toBeCloseTo(1.96, 2);
  });
});

describe("normalQuantile", () => {
  it("matches standard values", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.005)).toBeCloseTo(-2.575829, 6);
  });
});

describe("meanConfidenceInterval", () => {
  it("uses the t distribution for small n", () => {
    const ci = meanConfidenceInterval([1, 2, 3, 4, 5]);
    expect(ci.mean).toBe(3);
    expect(ci.n).toBe(5);
    expect(ci.halfWidth).toBeCloseTo((2.776445 * Math.sqrt(2.5)) / Math.sqrt(5), 5);
    expect(ci.lower).toBeCloseTo(3 - ci.halfWidth, 10);
    expect(ci.upper).toBeCloseTo(3 + ci.halfWidth, 10);
  });

  it("gives a zero-width interval for identical trials", () => {
    const ci = meanConfidenceInterval([0.8, 0.8, 0.8]);
    expect(ci.halfWidth).toBe(0);
    expect(ci.lower).toBe(ci.upper);
    expect(ci.mean).toBeCloseTo(0.8, 12);
  });
});

describe("wilsonInterval", () => {
  it("matches published values", () => {
    const interval = wilsonInterval(8, 10);
    expect(interval.rate).toBe(0.8);
    expect(interval.lower).toBeCloseTo(0.4902, 4);
    expect(interval.upper).toBeCloseTo(0.9433, 4);
  });

  it("stays inside [0, 1] at the extremes", () => {
    expect(wilsonInterval(0, 5).lower).toBe(0);
    expect(wilsonInterval(0, 5).upper).toBeCloseTo(0.4345, 4);
    expect(wilsonInterval(5, 5).upper).toBe(1);
    expect(wilsonInterval(5, 5).lower).toBeCloseTo(0.5655, 4);
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonInterval(3, 2)).toThrow();
    expect(() => wilsonInterval(0, 0)).toThrow(InsufficientDataError);
    expect(() => wilsonInterval(1.5, 3)).toThrow();
  });
});

describe("welchTTest", () => {
  const a1 = [
    27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4,
  ];
  const a2 = [
    27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4,
  ];
  const b1 = [17.2, 20.9, 22.6, 18.1, 21.7, 21.4, 23.5, 24.2, 14.7, 21.8];
  const b2 = [
    21.5, 22.8, 21.0, 23.0, 21.6, 23.6, 22.5, 20.7, 23.4, 21.8, 20.7, 21.7, 21.5, 22.5, 23.6, 21.5,
    22.5, 23.5, 21.5, 21.8,
  ];

  it("reproduces the equal-size reference example (t = -2.46, df = 24.99, p = 0.021)", () => {
    const result = welchTTest(a1, a2);
    expect(result.t).toBeCloseTo(-2.46, 2);
    expect(result.df).toBeCloseTo(24.9885, 4);
    expect(result.pValue).toBeCloseTo(0.021, 3);
  });

  it("reproduces the unequal-size reference example (t = -1.57, df = 9.9, p = 0.149)", () => {
    const result = welchTTest(b1, b2);
    expect(result.t).toBeCloseTo(-1.57, 2);
    expect(result.df).toBeCloseTo(9.9, 1);
    expect(result.pValue).toBeCloseTo(0.149, 3);
  });

  it("is symmetric and gives p = 1 for identical samples", () => {
    expect(welchTTest(a2, a1).pValue).toBeCloseTo(welchTTest(a1, a2).pValue, 12);
    expect(welchTTest([1, 2, 3], [1, 2, 3]).pValue).toBeCloseTo(1, 12);
  });

  it("handles zero variance in both samples", () => {
    expect(welchTTest([1, 1, 1], [1, 1, 1]).pValue).toBe(1);
    expect(welchTTest([1, 1, 1], [0, 0, 0]).pValue).toBe(0);
  });
});

describe("isRegression", () => {
  const baseline = [0.9, 0.88, 0.91, 0.89, 0.9];

  it("flags a drop that is both larger than the threshold and significant", () => {
    expect(isRegression(baseline, [0.7, 0.72, 0.69, 0.71, 0.7], 0.05)).toBe(true);
  });

  it("ignores drops smaller than the threshold even when significant", () => {
    expect(isRegression(baseline, [0.87, 0.86, 0.88, 0.87, 0.86], 0.05)).toBe(false);
  });

  it("ignores large but noisy drops that are not significant", () => {
    expect(isRegression([0.9, 0.2, 1.0], [0.3, 0.9, 0.4], 0.05)).toBe(false);
  });

  it("never flags an improvement", () => {
    expect(isRegression(baseline, [0.99, 0.98, 0.99], 0.05)).toBe(false);
  });

  it("supports lower-is-better metrics such as cost", () => {
    const cost = [100, 102, 98, 101, 99];
    expect(isRegression(cost, [130, 128, 131, 129, 132], 20, { higherIsBetter: false })).toBe(true);
    expect(isRegression(cost, [70, 72, 69], 20, { higherIsBetter: false })).toBe(false);
  });

  it("reports the comparison it based the verdict on", () => {
    const comparison = compareScores(baseline, [0.7, 0.72, 0.69, 0.71, 0.7], 0.05);
    expect(comparison.worsening).toBeCloseTo(0.192, 3);
    expect(comparison.pValue).toBeLessThan(0.001);
    expect(comparison.regression).toBe(true);
  });

  it("tests the worsening against the threshold one-sided: t = (worsening - threshold) / SE", () => {
    const comparison = compareScores([1, 3], [0, 2], 0.5);
    expect(comparison.worsening).toBe(1);
    expect(comparison.standardError).toBeCloseTo(Math.SQRT2, 12);
    expect(comparison.df).toBeCloseTo(2, 12);
    const t = 0.5 / Math.SQRT2;
    expect(comparison.t).toBeCloseTo(t, 12);
    expect(comparison.pValue).toBeCloseTo(0.5 - t / (2 * Math.sqrt(2 + t * t)), 10);
    expect(comparison.pValue).toBeCloseTo(0.378732, 6);
    expect(comparison.regression).toBe(false);
  });

  it("gives half the two-sided Welch p-value at threshold 0 when the candidate is worse", () => {
    const candidate = [0.85, 0.83, 0.9, 0.84, 0.86];
    const twoSided = welchTTest(baseline, candidate).pValue;
    expect(compareScores(baseline, candidate, 0).pValue).toBeCloseTo(twoSided / 2, 12);
  });

  it("does not flag a drop that is only significant against zero, not against the threshold", () => {
    const steady = [0.9, 0.91, 0.89, 0.9, 0.9];
    const candidate = [0.845, 0.855, 0.835, 0.845, 0.845];
    expect(welchTTest(steady, candidate).pValue).toBeLessThan(0.001);
    const comparison = compareScores(steady, candidate, 0.05);
    expect(comparison.worsening).toBeCloseTo(0.055, 12);
    expect(comparison.pValue).toBeGreaterThan(0.05);
    expect(comparison.regression).toBe(false);
  });

  it("handles zero variance on both sides", () => {
    expect(compareScores([1, 1, 1], [0, 0, 0], 0.5)).toMatchObject({ pValue: 0, regression: true });
    expect(compareScores([1, 1, 1], [0, 0, 0], 1)).toMatchObject({ pValue: 1, regression: false });
  });

  it("requires at least two trials per side", () => {
    expect(() => isRegression([0.9], [0.1, 0.2], 0.05)).toThrow(InsufficientDataError);
  });
});

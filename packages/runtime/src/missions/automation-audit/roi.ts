export const AUDIT_FORMULA =
  "hours/month = frequency × minutes × people × adoption / 60; €/month = hours × hourly cost";

export interface RoiInputs {
  frequencyPerMonth: number;
  minutesPerTask: number;
  peopleInvolved: number;
  adoptionRate: number;
  hourlyCostEur: number;
}

export interface RoiEstimate {
  inputs: RoiInputs;
  hoursPerMonth: number;
  eurPerMonth: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function estimateRoi(
  opportunity: RoiInputs,
  overrides: Partial<RoiInputs> = {},
): RoiEstimate {
  const merged = { ...opportunity, ...overrides };
  const inputs: RoiInputs = {
    frequencyPerMonth: nonNegative(merged.frequencyPerMonth),
    minutesPerTask: nonNegative(merged.minutesPerTask),
    peopleInvolved: nonNegative(merged.peopleInvolved),
    adoptionRate: Math.min(1, nonNegative(merged.adoptionRate)),
    hourlyCostEur: nonNegative(merged.hourlyCostEur),
  };
  const hours =
    (inputs.frequencyPerMonth *
      inputs.minutesPerTask *
      inputs.peopleInvolved *
      inputs.adoptionRate) /
    60;
  return {
    inputs,
    hoursPerMonth: Math.round(hours * 10) / 10,
    eurPerMonth: Math.round(hours * inputs.hourlyCostEur),
  };
}

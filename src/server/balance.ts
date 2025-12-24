function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Anti-snowball: keep late-game moving & punish pure turtling.
export const MASS_DECAY_START = 1000;
export const MASS_DECAY_RATE = 0.005; // 0.5% per second (exponential)
export const MASS_DECAY_SEGMENT_MUL = 0.42; // convert "mass" loss into size loss (approx)

export const TURN_PENALTY_BASE_MASS = 1000;
export const TURN_PENALTY_PER_DOUBLING = 0.85; // -15% per doubling
export const TURN_PENALTY_MIN = 0.5; // keep controls usable

export function turnPenaltyForMass(mass: number): number {
  if (!Number.isFinite(mass) || mass <= TURN_PENALTY_BASE_MASS) return 1;
  const doublings = Math.log2(mass / TURN_PENALTY_BASE_MASS);
  return clamp(Math.pow(TURN_PENALTY_PER_DOUBLING, doublings), TURN_PENALTY_MIN, 1);
}

// Class tuning
export const IRON_MASS_DECAY_MUL = 0.7; // 30% less decay (easier to keep size)
export const IRON_ARMOR_BOOST_RECOVER = 8; // segments/score restored per armor proc
export const SHADOW_KILL_REWARD_MUL = 1.2; // +20% corpse value (expected)


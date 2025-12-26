import type { MutationId, WormClass, WormSkin } from './protocol';

// Shared balance/config values (client + server).

export const START_MASS = 10;
export const MIN_SEGMENTS = 14;

// Base skill per class (available from game start).
export const CLASS_BASE_SKILL: Record<WormClass, MutationId> = {
  iron: 'iron_bunker_down',
  shadow: 'shadow_phantom_decoy',
  magnetic: 'ultimate_magnetic_magnet',
};

// Base skill per character skin (available from game start).
export const SKIN_BASE_SKILL: Record<WormSkin, MutationId> = {
  slug: 'ultimate_magnetic_magnet',
  viper: 'skill_viper_blender',
  eel: 'skill_eel_overdrive',
  venom: 'skill_venom_gas',
  scarab: 'skill_scarab_thorns',
  frost: 'skill_frost_domain',
  plasma: 'skill_plasma_ray',
  chrono: 'skill_chrono_rewind',
  mirage: 'skill_mirage_clones',
  void: 'skill_void_maw',
};

// Level progression (3-3-4): 300 / 1500 / 5000 mass.
export const EVO_THRESHOLDS: [number, number, number] = [300, 1500, 5000];
export const OFFER_COUNTS: [number, number, number] = [3, 3, 4];

export function buildOfferMilestones(
  start: number = START_MASS,
  thresholds: readonly [number, number, number] = EVO_THRESHOLDS,
  counts: readonly [number, number, number] = OFFER_COUNTS,
): number[] {
  const [t1, t2, t3] = thresholds;
  const [c1, c2, c3] = counts;

  const mk = (from: number, to: number, count: number): number[] => {
    const span = to - from;
    if (count <= 0 || span <= 0) return [];
    const out: number[] = [];
    for (let i = 1; i <= count; i++) {
      out.push(Math.round(from + (span * i) / count));
    }
    out[out.length - 1] = to;
    return out;
  };

  return [...mk(start, t1, c1), ...mk(t1, t2, c2), ...mk(t2, t3, c3)];
}

// Skill cooldown tuning (authoritative server uses the same base values as the client UI).
export const MAGNETIC_ULT_CD_MUL = 0.8; // -20% ultimate cooldown

export const SKILL_BASE_COOLDOWN_MS: Partial<Record<MutationId, number>> = {
  // Skin skills
  skill_viper_blender: 25000,
  skill_eel_overdrive: 20000,
  skill_venom_gas: 25000,
  skill_scarab_thorns: 30000,
  skill_frost_domain: 20000,
  skill_plasma_ray: 20000,
  skill_chrono_rewind: 20000,
  skill_mirage_clones: 25000,
  skill_void_maw: 30000,

  iron_bunker_down: 20000,
  shadow_phantom_decoy: 18000,
  ultimate_iron_charge: 20000,
  ultimate_iron_fortress: 22000,
  ultimate_iron_shockwave: 18000,
  ultimate_shadow_phase: 18000,
  ultimate_shadow_smokescreen: 22000,
  ultimate_shadow_dash: 15000,
  ultimate_magnetic_magnet: 20000,
  ultimate_magnetic_goldrush: 25000,
  ultimate_magnetic_overcharge: 20000,
};

export function skillCooldownMs(dna: WormClass, skill: MutationId): number | undefined {
  const base = SKILL_BASE_COOLDOWN_MS[skill];
  if (base == null) return undefined;
  if (dna === 'magnetic' && skill.startsWith('ultimate_magnetic_')) {
    return Math.round(base * MAGNETIC_ULT_CD_MUL);
  }
  return base;
}

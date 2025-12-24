export interface Vec2 {
  x: number;
  y: number;
}

export interface WorldConfig {
  width: number;
  height: number;
}

export type WormClass = 'iron' | 'shadow' | 'magnetic';

export type MutationStage = 1 | 2 | 3;

export type MutationId =
  | 'rocket_fuel'
  | 'flexible_spine'
  | 'lightweight'
  | 'iron_stomach'
  | 'eagle_eye'
  | 'sixth_sense'
  | 'spiked_tail'
  | 'toxic_trail'
  // Legacy ids (kept for compatibility)
  | 'spiky_skin'
  | 'double_jaw'
  | 'rocket_propulsion'
  | 'toxic_gas'
  | 'bait_bomb'
  | 'muscle_fiber'
  | 'iron_bunker_down'
  | 'shadow_phantom_decoy'
  | 'magnetic_hyper_metabolism'
  | 'ultimate_iron_charge'
  | 'ultimate_iron_fortress'
  | 'ultimate_iron_shockwave'
  | 'ultimate_shadow_phase'
  | 'ultimate_shadow_smokescreen'
  | 'ultimate_shadow_dash'
  | 'ultimate_magnetic_magnet'
  | 'ultimate_magnetic_goldrush'
  | 'ultimate_magnetic_overcharge';

export type MutationRarity = 'common' | 'rare' | 'legend';

export interface MutationChoice {
  id: MutationId;
  name: string;
  desc: string;
  rarity: MutationRarity;
}

export interface MutationOfferPayload {
  stage: MutationStage;
  choices: MutationChoice[];
}

export interface FoodState {
  id: string;
  x: number;
  y: number;
  r: number;
  color: number;
  value: number;
}

export interface GasState {
  id: string;
  x: number;
  y: number;
  r: number;
}

export interface BlackHoleState {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  r: number;
  expiresAt: number;
}

export interface DecoyState {
  id: string;
  ownerId: string;
  name: string;
  color: number;
  dna: WormClass;
  originalLen: number;
  segments: Vec2[];
}

export interface PlayerState {
  id: string;
  name: string;
  color: number;
  boost: boolean;
  dna: WormClass;
  armor: number;
  stealth: boolean;
  phase: boolean;
  evoStage: number;
  nextEvoScore: number;
  skillCdMs: number;
  skillActive: boolean;
  mutations: MutationId[];
  segments: Vec2[];
  score: number;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  color: number;
  score: number;
}

export interface StatePayload {
  now: number;
  world: WorldConfig;
  players: Record<string, PlayerState>;
  decoys: DecoyState[];
  foods: FoodState[];
  gas: GasState[];
  blackHoles: BlackHoleState[];
  leaderboard: LeaderboardEntry[];
}

export interface WelcomePayload {
  id: string;
  world: WorldConfig;
  tickRate: number;
}

export interface DeadPayload {
  reason: string;
  score: number;
}

export interface ClientToServerEvents {
  join: (payload: { name: string; dna: WormClass }) => void;
  input: (payload: { angle: number; boost: boolean }) => void;
  ability: (payload: { type: 'skill'; action?: 'tap' | 'start' | 'end'; x?: number; y?: number }) => void;
  chooseMutation: (payload: { id: MutationId }) => void;
  respawn: () => void;
}

export interface ServerToClientEvents {
  welcome: (payload: WelcomePayload) => void;
  state: (payload: StatePayload) => void;
  dead: (payload: DeadPayload) => void;
  mutationOffer: (payload: MutationOfferPayload) => void;
}

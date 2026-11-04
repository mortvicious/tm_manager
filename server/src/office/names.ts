// Generated role identities (docs/office.md § Presets → Names): a name and an
// avatar per role, deterministic for (office id, role key) and themed by the
// office's visual theme. Generated once when a role is created; the human may
// rename it afterwards — nothing re-derives a stored name.
import { createHash } from 'node:crypto';

export type OfficeTheme = 'pixel-office' | 'starship-bridge' | 'fantasy-guild' | 'space-colony';
export const OFFICE_THEMES: readonly OfficeTheme[] = ['pixel-office', 'starship-bridge', 'fantasy-guild', 'space-colony'];
export const DEFAULT_OFFICE_THEME: OfficeTheme = 'pixel-office';

export const OFFICE_THEME_LABELS: Readonly<Record<OfficeTheme, string>> = {
  'pixel-office': 'Pixel office',
  'starship-bridge': 'Starship bridge',
  'fantasy-guild': 'Fantasy guild hall',
  'space-colony': 'Space colony',
};

/** `Office.theme` is a free id: anything unknown reads as the default theme. */
export function officeTheme(theme: string | null | undefined): OfficeTheme {
  return OFFICE_THEMES.includes(theme as OfficeTheme) ? (theme as OfficeTheme) : DEFAULT_OFFICE_THEME;
}

interface ThemePool {
  /** given names; disjoint across themes so the same seed never names alike in two themes */
  names: readonly string[];
  /** how the name is dressed per role key (`{n}` = the picked name); `*` = any other role */
  format: Readonly<Record<string, string>>;
  avatars: Readonly<Record<string, readonly string[]>>;
}

const POOLS: Readonly<Record<OfficeTheme, ThemePool>> = {
  'pixel-office': {
    names: ['Pat', 'Dana', 'Max', 'Robin', 'Sam', 'Lee', 'Jo', 'Kit', 'Alex', 'Casey', 'Morgan', 'Riley', 'Quinn', 'Toby', 'Nico', 'Jules'],
    format: { director: 'Boss {n}', '*': '{n}' },
    avatars: {
      director: ['👔', '🧑‍💼', '📋'],
      developer: ['🧑‍💻', '👩‍💻', '👨‍💻', '⌨️'],
      devops: ['🛠️', '🔧', '🖥️'],
      qa: ['🔍', '🧪', '🐞'],
      seo: ['📈', '🔎', '📰'],
      '*': ['🙂', '🗂️', '☕', '📎'],
    },
  },
  'starship-bridge': {
    names: ['Vega', 'Orion', 'Kirra', 'Talos', 'Nova', 'Rhea', 'Cassian', 'Lyra', 'Juno', 'Sirius', 'Altair', 'Deneb', 'Mira', 'Rigel', 'Castor', 'Elara'],
    format: {
      director: 'Captain {n}',
      developer: 'Chief Engineer {n}',
      devops: 'Ops Officer {n}',
      qa: 'Science Officer {n}',
      seo: 'Comms Officer {n}',
      '*': 'Lt. {n}',
    },
    avatars: {
      director: ['🧑‍✈️', '🚀', '⭐'],
      developer: ['🔩', '⚙️', '🛸'],
      devops: ['📡', '🛰️', '🔋'],
      qa: ['🔬', '🧬', '🌌'],
      seo: ['📻', '📶', '🔭'],
      '*': ['👽', '🌠', '🪐'],
    },
  },
  'fantasy-guild': {
    names: ['Elowen', 'Thorin', 'Brynn', 'Aldric', 'Isolde', 'Garrick', 'Seren', 'Rowan', 'Maelis', 'Corwin', 'Wren', 'Faelan', 'Ysolde', 'Bram', 'Tamsin', 'Oren'],
    format: {
      director: 'Guildmaster {n}',
      developer: '{n} the Artificer',
      devops: '{n} the Smith',
      qa: '{n} the Seeker',
      seo: '{n} the Herald',
      '*': '{n} the Wanderer',
    },
    avatars: {
      director: ['👑', '🏰', '🦉'],
      developer: ['🧙', '📜', '🪄'],
      devops: ['⚒️', '🔥', '🛡️'],
      qa: ['🗡️', '🕵️', '🐉'],
      seo: ['📯', '🗺️', '🦅'],
      '*': ['🧝', '🍄', '🕯️'],
    },
  },
  'space-colony': {
    names: ['Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Haddad', 'Kowalski', 'Reyes', 'Achebe', 'Varga', 'Sato', 'Novak', 'Mensah', 'Ilunga', 'Park', 'Duarte', 'Brandt'],
    format: {
      director: 'Administrator {n}',
      developer: 'Engineer {n}',
      devops: 'Life-support Chief {n}',
      qa: 'Dr. {n}',
      seo: 'Liaison {n}',
      '*': 'Colonist {n}',
    },
    avatars: {
      director: ['🏛️', '🌍', '🧭'],
      developer: ['🤖', '🦾', '💡'],
      devops: ['🌱', '♻️', '🔌'],
      qa: ['🩺', '⚗️', '🧫'],
      seo: ['📢', '🗞️', '🌐'],
      '*': ['👩‍🚀', '🧑‍🚀', '🏕️'],
    },
  },
};

export interface RoleIdentity {
  name: string;
  avatar: string;
}

/** A stable unsigned 32-bit number from the seed parts. */
function seedOf(...parts: string[]): number {
  return createHash('sha256').update(parts.join('\u0000')).digest().readUInt32BE(0);
}

/**
 * The generated name and avatar for one role. Same (office id, role key,
 * theme) → same identity, always; `salt` steps to the next candidate (used by
 * `generateOfficeIdentities` to avoid two roles sharing a name).
 */
export function generateRoleIdentity(officeId: string, roleKey: string, theme: string | null | undefined, salt = 0): RoleIdentity {
  const t = officeTheme(theme);
  const pool = POOLS[t];
  const seed = seedOf(officeId, roleKey);
  const given = pool.names[(seed + salt) % pool.names.length]!;
  const format = pool.format[roleKey] ?? pool.format['*']!;
  const avatars = pool.avatars[roleKey] ?? pool.avatars['*']!;
  return {
    name: format.replace('{n}', given),
    avatar: avatars[(seed >>> 8) % avatars.length]!,
  };
}

/**
 * Identities for a whole office, in `roleKeys` order, with no two roles
 * sharing a given name (a later key steps to the next free name). Still
 * deterministic: the same keys in the same order give the same result.
 */
export function generateOfficeIdentities(
  officeId: string,
  roleKeys: readonly string[],
  theme: string | null | undefined,
): Record<string, RoleIdentity> {
  const pool = POOLS[officeTheme(theme)];
  const used = new Set<number>();
  const out: Record<string, RoleIdentity> = {};
  for (const key of roleKeys) {
    if (out[key]) continue;
    const base = seedOf(officeId, key) % pool.names.length;
    let salt = 0;
    while (used.has((base + salt) % pool.names.length) && salt < pool.names.length) salt++;
    used.add((base + salt) % pool.names.length);
    out[key] = generateRoleIdentity(officeId, key, theme, salt);
  }
  return out;
}

// Runner skins.
//
// A skin is only a palette. The character's geometry bakes its colours into a
// vertex attribute (see geo.js), so changing skin means rebuilding those few
// small merged geometries — which is why this is a list of colours and not a
// list of models.
//
// `swatch` names the three palette entries the store shows as dots. Picking
// them by hand beats deriving them: the colours that identify a skin at a
// glance are not always the ones covering the most surface area.

export const SKINS = [
  {
    id: 'explorer',
    name: 'Explorer',
    price: 0,
    swatch: ['shirt', 'pants', 'gold'],
    palette: {
      skin: 0xd9a06b,
      shirt: 0xb8392c,
      shirtDark: 0x8e2a20,
      pants: 0x2f4257,
      boot: 0x3a2a1c,
      hair: 0x5c3f26,
      gold: 0xe8b849,
      pack: 0x6b5334,
      dark: 0x14100c,
    },
  },
  {
    id: 'jade',
    name: 'Jade Monk',
    price: 200,
    swatch: ['shirt', 'gold', 'pants'],
    palette: {
      skin: 0xc9925e,
      shirt: 0x2f8a6d,
      shirtDark: 0x1f6650,
      pants: 0x1d3b3a,
      boot: 0x2a2620,
      hair: 0x1c1410,
      gold: 0xe0d08a,
      pack: 0x3f5a4a,
      dark: 0x10140f,
    },
  },
  {
    id: 'bone',
    name: 'Bone Shaman',
    price: 450,
    swatch: ['shirt', 'dark', 'gold'],
    palette: {
      skin: 0xd8b98f,
      shirt: 0xd9cdb4,
      shirtDark: 0xb0a389,
      pants: 0x3a352e,
      boot: 0x24201a,
      hair: 0xe8e2d2,
      gold: 0xc07a3a,
      pack: 0x6e6353,
      dark: 0x141210,
    },
  },
  {
    id: 'ember',
    name: 'Ember Warden',
    price: 800,
    swatch: ['gold', 'shirt', 'dark'],
    palette: {
      skin: 0xb07a4e,
      shirt: 0x33302e,
      shirtDark: 0x201d1c,
      pants: 0x262220,
      boot: 0x171412,
      hair: 0x14100e,
      gold: 0xff7a2a,
      pack: 0x4a3a30,
      dark: 0x0d0b0a,
    },
  },
  {
    id: 'royal',
    name: 'Sun Prince',
    price: 1400,
    swatch: ['shirt', 'gold', 'pants'],
    palette: {
      skin: 0xdca873,
      shirt: 0x6b3f9e,
      shirtDark: 0x4d2b78,
      pants: 0x2a2450,
      boot: 0x3a2f1a,
      hair: 0x241a12,
      gold: 0xffd24a,
      pack: 0x8a6a2a,
      dark: 0x151024,
    },
  },
];

const BY_ID = new Map(SKINS.map((s) => [s.id, s]));

export function skinById(id) {
  return BY_ID.get(id) || SKINS[0];
}

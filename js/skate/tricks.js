// The trick catalogue.
//
// A trick is described by how much the board rotates about each of its own axes
// and nothing else. The board's local axes are +Z through the nose, +Y up
// through the grip tape and +X out to the heel side, so:
//
//   flip   revolutions about Z — kickflips and heelflips
//   shuv   revolutions about Y — shove-its
//   pitch  revolutions about X — impossibles, end over end
//
// Every combination that has a name in real life is a combination of those three
// numbers, which is why the catalogue is a table rather than a pile of special
// cases. The time a trick needs is not authored either: it falls out of the
// rotation and the flick speeds in config.js, so a tre flip needs more air than a
// kickflip for the same reason it does on a board — there is more to get round.

/** Positive flip is a kickflip: the toe-side edge dives first. */
export const TRICKS = [
  { id: 'ollie', name: 'Ollie', flip: 0, shuv: 0, pitch: 0, points: 100 },
  { id: 'kickflip', name: 'Kickflip', flip: 1, shuv: 0, pitch: 0, points: 250 },
  { id: 'heelflip', name: 'Heelflip', flip: -1, shuv: 0, pitch: 0, points: 250 },
  { id: 'shuvit', name: 'Pop Shuvit', flip: 0, shuv: 0.5, pitch: 0, points: 180 },
  { id: 'fsshuvit', name: 'Frontside Shuvit', flip: 0, shuv: -0.5, pitch: 0, points: 180 },
  { id: 'shuv360', name: '360 Shuvit', flip: 0, shuv: 1, pitch: 0, points: 380 },
  { id: 'varial', name: 'Varial Kickflip', flip: 1, shuv: 0.5, pitch: 0, points: 420 },
  { id: 'varialheel', name: 'Varial Heelflip', flip: -1, shuv: -0.5, pitch: 0, points: 420 },
  { id: 'treflip', name: '360 Flip', flip: 1, shuv: 1, pitch: 0, points: 700 },
  { id: 'hardflip', name: 'Hardflip', flip: 1, shuv: -0.5, pitch: 0, points: 560 },
  { id: 'impossible', name: 'Impossible', flip: 0, shuv: 0, pitch: 1, points: 620 },
];

export const byId = Object.fromEntries(TRICKS.map((t) => [t.id, t]));

/**
 * The name a landed trick actually gets, given the stance it was done from and
 * how far the body spun on the way.
 *
 * The prefixes are the real ones and they are not interchangeable: rolling
 * backwards is fakie, popping off the nose while rolling forwards is nollie, and
 * a trick done with the wrong foot forward is switch.
 */
export function trickName(def, { fakie = false, spin = 0 } = {}) {
  let name = def.name;
  if (fakie) name = `Fakie ${name}`;
  const half = Math.round(Math.abs(spin) / Math.PI);
  if (half >= 1) {
    const degrees = half * 180;
    // A body rotation reads as the headline, with the board trick hung off it.
    name = def.id === 'ollie' ? `${degrees}` : `${name} ${degrees}`;
    if (fakie && def.id === 'ollie') name = `Fakie ${degrees}`;
  }
  return name;
}

/** Points, with the spin paid for separately from the board rotation. */
export function trickScore(def, { spin = 0, fakie = false } = {}) {
  const half = Math.round(Math.abs(spin) / Math.PI);
  let points = def.points + half * 140;
  if (fakie) points = Math.round(points * 1.15); // harder, and it should pay
  return points;
}

// --- grinds ---------------------------------------------------------------
/**
 * What a grind is called, from how the board is sitting on the rail.
 *
 * `across` is the angle between the deck and the rail, `nose`/`tail` say which
 * end is pressed. These are the real names for those geometries — the point of
 * getting them right is that a player who skates recognises what they just did.
 */
export function grindName(across, tailPress, nosePress, kind) {
  const a = Math.abs(across);
  if (a > Math.PI * 0.35) {
    // Board across the rail. Which side you came from decides the name; from the
    // rider's point of view the difference is which way they turned into it.
    return across > 0 ? 'Boardslide' : 'Lipslide';
  }
  if (a > Math.PI * 0.12) return across > 0 ? 'Crooked Grind' : 'Feeble Grind';
  if (tailPress) return kind === 'ledge' ? 'Tail Slide' : '5-0 Grind';
  if (nosePress) return kind === 'ledge' ? 'Nose Slide' : 'Nosegrind';
  return kind === 'ledge' ? 'Board Slide' : '50-50 Grind';
}

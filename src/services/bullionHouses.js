/**
 * The bullion houses a shop can follow, and which one a stored choice names.
 *
 * The 3-minute feed is the list: every house on it can be followed, by its
 * `source` key, under the feed's own name. The settings screen
 * (GET/POST /settings/bullion) and the rate calculation both read the choice
 * through followedHouse, so the house ticked on the phone is the house a
 * scan is priced on.
 *
 * No requires on purpose: pure, so it reads the same under every test stub.
 */

/** The two houses the older boolean (bhaw_source_jmd) chose between, and two more. */
const SOURCES = {
  JMD_PATIL: 'jmd_patil',
  MEGA_BULLION: 'mega_bullion',
  SHRI_SAI: 'shri_sai',
  SHRI_GANESH: 'shri_ganesh',
};

/**
 * Every house the feed is known to carry, by its feed name (as on
 * 19 Oct 2026). Only a stand-in: while a board is in hand its own houses and
 * names are the list, and a house it adds can be followed without a change
 * here. This is the list while no board has come in yet, and the name of a
 * house the board does not name.
 */
const SOURCE_NAMES = {
  jmd_patil: 'JMD Patil',
  mega_bullion: 'Mega Bullion',
  shri_sai: 'Shri Sai Jewels',
  shri_ganesh: 'Shri Ganesh Bullion',
  smd_bullion: 'SMD Bullion',
  shree_ram: 'Shree Ram Jewellers',
  kp_bullion: 'KP Bullion',
  vijaylaxmi_bullion: 'Vijaylaxmi Bullion',
  kj_bullion: 'KJ Bullion',
  sms_bullion: 'SMS Bullion',
  sln_bullion: 'SLN Bullion',
};

/** A house key as the feed writes one ("smd_bullion"). */
const HOUSE_KEY = /^[a-z0-9_]{1,40}$/;

/** The known houses as [{ key, label }], in the feed's order. */
const knownHouses = () => Object.entries(SOURCE_NAMES).map(([key, label]) => ({ key, label }));

/** How a name is matched to a house: case and spaces aside ("smd  bullion" is SMD Bullion). */
const houseNameKey = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * The house in `houses` that `value` names — by its key, or by its name with
 * case and spaces aside — or null when it names none of them.
 */
const findHouse = (houses, value) => {
  const wanted = houseNameKey(value);
  if (!wanted || !Array.isArray(houses)) return null;
  return houses.find((house) => house.key === wanted)
    || houses.find((house) => houseNameKey(house.label) === wanted)
    || null;
};

/**
 * The house an account follows, as { key, label }.
 *
 *   board      followableHouses(): { houses, fromFeed }
 *   stored     BullionSource.selected
 *   legacyJmd  DashboardMetrics bhaw_source_jmd
 *
 * The stored choice when it names a house on the board, or one the feed is
 * known to carry (a house off the board for a round is still the shop's
 * house). With no board in hand at all, a stored house key is kept as it
 * stands: a feed that is down never moves a shop off its house. Anything
 * else — nothing chosen yet, or a name the shop added that is on no board —
 * is the older boolean's house: JMD Patil unless it is saved false, then
 * Mega Bullion.
 */
const followedHouse = (board, stored, legacyJmd) => {
  const houses = Array.isArray(board?.houses) ? board.houses : [];
  const match = findHouse(houses, stored) || findHouse(knownHouses(), stored);
  if (match) return { key: match.key, label: match.label };
  const raw = String(stored ?? '').trim();
  if (!board?.fromFeed && HOUSE_KEY.test(raw)) return { key: raw, label: SOURCE_NAMES[raw] || raw };
  const key = legacyJmd === false ? SOURCES.MEGA_BULLION : SOURCES.JMD_PATIL;
  const onBoard = findHouse(houses, key);
  return { key, label: onBoard?.label || SOURCE_NAMES[key] };
};

module.exports = {
  SOURCES,
  SOURCE_NAMES,
  HOUSE_KEY,
  knownHouses,
  houseNameKey,
  findHouse,
  followedHouse,
};

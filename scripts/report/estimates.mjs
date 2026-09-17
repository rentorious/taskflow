// Time estimates arrive as free text written by the triage model: "30-45 min",
// "2 hours", "30 min - 1 hour", and sometimes multi-clause prose such as
// "8-12 hours (Phase 1 ~5-7h ...), blocked on a payment account". We parse the
// leading quantity into a minute range and flag everything else as a caveat, so
// the UI can show "6h-9h, 2 with caveats" instead of pretending to one number.

const UNIT_MINUTES = { m: 1, h: 60, d: 480 };
const QUANTITY = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)?(?![a-z])/gi;
const RANGE_SPLIT = /\s*(?:-|–|—|\bto\b)\s*/i;
const CAVEAT_WORDS = /\b(blocked|depends|pending|plus|unknown|tbd|if)\b/i;

function unitOf(word) {
  return word ? word[0].toLowerCase() : null;
}

/** Sum every "<number><unit>" pair on one side of a range ("1h 30m" -> 90). */
function readSide(text) {
  const parts = [];
  for (const m of text.matchAll(QUANTITY)) parts.push({ value: Number(m[1]), unit: unitOf(m[2]) });
  return parts;
}

function sideMinutes(parts, fallbackUnit) {
  let total = 0;
  for (const p of parts) {
    const unit = p.unit || fallbackUnit;
    if (!unit) return null;
    total += p.value * UNIT_MINUTES[unit];
  }
  return Math.round(total);
}

/**
 * @param {unknown} raw
 * @returns {{raw: string, minMinutes: number|null, maxMinutes: number|null, parsed: boolean, caveat: boolean}}
 */
export function parseEstimate(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const empty = { raw: text, minMinutes: null, maxMinutes: null, parsed: false, caveat: false };
  if (!text) return empty;

  const body = text.replace(/^[~≈\s]+/, '');
  const head = body.split(/[(;,]/)[0].trim();
  const caveat = head.length < body.length || CAVEAT_WORDS.test(body);

  // A side with no number ("2 hours to fix" -> "fix") is prose, not a bound.
  const sides = head.split(RANGE_SPLIT).map(readSide).filter((s) => s.length > 0).slice(0, 2);
  if (sides.length === 0) return { ...empty, caveat };

  // "30-45 min": the left side has no unit of its own and borrows the right's.
  const lastUnit = (parts) => [...parts].reverse().find((p) => p.unit)?.unit || null;
  const borrowed = lastUnit(sides[sides.length - 1]) || lastUnit(sides[0]);

  const mins = sides.map((s) => sideMinutes(s, borrowed));
  if (mins.some((m) => m === null)) return { ...empty, caveat };

  const minMinutes = Math.min(...mins);
  const maxMinutes = Math.max(...mins);
  return { raw: text, minMinutes, maxMinutes, parsed: true, caveat };
}

/** Roll a list of parsed estimates into one range plus honesty counters. */
export function sumEstimates(list) {
  const total = { minMinutes: 0, maxMinutes: 0, count: 0, unparsed: 0, caveats: 0 };
  for (const e of list) {
    if (!e || !e.raw) continue;
    total.count++;
    if (e.caveat) total.caveats++;
    if (!e.parsed) { total.unparsed++; continue; }
    total.minMinutes += e.minMinutes;
    total.maxMinutes += e.maxMinutes;
  }
  return total;
}

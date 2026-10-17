import { DateTime } from 'luxon';
import { DATE_TOKENS } from '../agent/tools/common.js';
import { bookPerson, OPERATOR_SKILL, pickPerson, shiftSegments } from './people.js';

/**
 * Operators for production job cards (phase 7 §3.2): one Production person per shift segment of each card's
 * window, skill-matched to the machine type, never double-booked across the plan. Pure: `people` is copied.
 */

const ms = (d) => new Date(d).getTime();

/** `No Production operator is free for IMM 3 in shift C on 18-10-2026` as a warning issue. */
export const operatorMissing = (card, machine, segment, { zone, dateFormat }) => ({
  kind: 'operator_missing',
  severity: 'warning',
  text: `No Production operator is free for ${machine?.name ?? card.assetId} in shift ${segment.shiftName} on ${DateTime.fromJSDate(
    new Date(segment.start),
    { zone },
  ).toFormat(DATE_TOKENS[dateFormat] ?? 'dd-MM-yyyy')}`,
  jobCard: card.key,
  assetId: card.assetId,
});

/** Operator skill wanted on a machine (none for unknown types). */
export const skillsFor = (machine) => [OPERATOR_SKILL[machine?.typeOfAsset]].filter(Boolean);

/**
 * @param {[{ key, assetId, start, end }]} jobCards
 * @param {{ people: Person[], plant, zone, machinesById: Map, dateFormat? }} opts
 * @returns {Map<string, { operators: Operator[], issues: Issue[], shifts: number }>} by card key;
 *   Operator = { userId, name, shiftId, shiftName, start, end }
 */
export const assignOperators = (jobCards, { people, plant, zone, machinesById, dateFormat }) => {
  const roster = structuredClone(people);
  const out = new Map();
  for (const card of [...jobCards].sort((a, b) => ms(a.start) - ms(b.start))) {
    const machine = machinesById.get(String(card.assetId));
    const skills = skillsFor(machine);
    const operators = [];
    const issues = [];
    const segments = plant ? shiftSegments(plant, { start: card.start, end: card.end }, zone) : [];
    for (const seg of segments) {
      const pick = pickPerson(roster, seg, { skills });
      if (!pick) {
        issues.push(operatorMissing(card, machine, seg, { zone, dateFormat }));
        continue;
      }
      bookPerson(pick, { kind: 'jobcard', id: card.key, code: card.key, start: seg.start, end: seg.end });
      operators.push({
        userId: pick.userId,
        name: pick.name,
        shiftId: seg.shiftId ?? null,
        shiftName: seg.shiftName,
        start: seg.start,
        end: seg.end,
      });
    }
    out.set(card.key, { operators, issues, shifts: segments.length });
  }
  return out;
};

/** Job card fields from the operators: `assignedTo` (unique ids) and `operatorPlan` rows. */
export const operatorFields = (operators) => ({
  assignedTo: [...new Set(operators.map((o) => o.userId))],
  operatorPlan: operators.map(({ userId, shiftName, start, end }) => ({
    user: userId,
    shiftName,
    start,
    end,
  })),
});

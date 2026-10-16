import { DateTime } from 'luxon';
import { z } from 'zod';
import { toJsonSchema } from '../agent/declarations.js';
import { plantName, zoneOf } from '../agent/tools/common.js';
import { AiUnavailableError, generate } from '../ai/gemini.js';
import { getAiSettings } from '../ai/settings.js';
import { AiText } from '../db/models/AiText.js';
import { buildEvidence } from './evidence.js';

/** The Command Center briefing (phase 5 §3.10, §4 briefing): live evidence plus one cached AI text per scope and day. */

export const EVIDENCE_KEYS = ['production', 'oee', 'downtime', 'anomalies', 'maintenance', 'costs'];
const briefingSchema = z.object({
  headline: z.string().max(120),
  narrative: z.string().max(900),
  actions: z
    .array(
      z.object({
        title: z.string().max(100),
        why: z.string().max(200),
        link: z.string().max(200).nullable(),
        ask: z.string().max(300).nullable(),
      }),
    )
    .length(3),
  evidence: z.array(z.enum(EVIDENCE_KEYS)).min(1).max(4),
});
const SYSTEM = `You are SARA, the AI operations lead of a manufacturing plant. Write the shift briefing for the plant team from today's evidence: production against plan, OEE (fractions 0–1, last 7 days), downtime, open anomalies, maintenance due, month-to-date costs and job cards behind plan.
Give a headline (under 12 words), a short narrative of what matters most and why, exactly 3 concrete actions, and the 1–4 evidence sections that best back the narrative.
Each action has a title, why it matters, and either an in-app link (a path such as /planner?maintenance=<assetId>&anomaly=<anomalyId>, /machines/<assetId>, /m/workorders, /costs, /anomalies, /planner) or a question for the assistant ("ask"); set the other to null.
Use only the numbers and names in the input; amounts are in the given currency. Plain words, no markdown.`;
const HOUR = 3_600_000;
const inflight = new Map(); // companyId|key → running AI call

/** Cache key: scope (plant lock or all) and the local day. */
export const briefingKey = (ctx, now) =>
  `${ctx.plantLock ? `plant:${ctx.plantLock}` : 'all'}|${DateTime.fromJSDate(now, { zone: zoneOf(ctx) }).toISODate()}`;

const present = (evidence) => EVIDENCE_KEYS.filter((k) => evidence[k]);

/** Links must stay in the app; evidence keys must point at sections the viewer has. */
const guard = (json, evidence) => {
  const have = new Set(present(evidence));
  const keys = json.evidence.filter((k) => have.has(k));
  return {
    ...json,
    actions: json.actions.map((a) => ({
      ...a,
      link: typeof a.link === 'string' && /^\/(?!\/)/.test(a.link) ? a.link : null,
    })),
    evidence: keys.length ? keys : [...have].slice(0, 2),
  };
};

/** Evidence without the UI blocks: the numbers the model reads. */
const numbersOf = (evidence) =>
  Object.fromEntries(
    Object.entries(evidence)
      .filter(([, v]) => v)
      .map(([k, { block, ...rest }]) => [k, rest]),
  );

const writeText = async (ctx, key, input, now) => {
  const res = await generate({
    tier: 'background',
    purpose: 'briefing',
    companyId: ctx.companyId,
    system: SYSTEM,
    contents: JSON.stringify(input),
    schema: toJsonSchema(briefingSchema),
    mockInput: { kind: 'briefing', ...input },
  });
  const parsed = briefingSchema.safeParse(res.json);
  if (!parsed.success)
    throw new AiUnavailableError('AI_ERROR', 'The AI briefing was not in the expected shape');
  return AiText.findOneAndUpdate(
    { companyId: ctx.companyId, kind: 'briefing', key },
    {
      $set: {
        json: parsed.data,
        evidence: input.evidence,
        model: res.model,
        mock: Boolean(res.mock),
        at: now,
      },
    },
    { upsert: true, new: true },
  ).lean();
};

/**
 * Live evidence and the AI briefing of the viewer's scope. The text is rewritten when older than
 * `briefingTtlHours`, on a new day, or on `refresh`; when the AI is unavailable the day's last text comes
 * back with `stale: true` (or a plain "Today so far" briefing when there is none) and `aiError`.
 */
export const getBriefing = async (ctx, { refresh = false, now = new Date() } = {}) => {
  const evidence = await buildEvidence(ctx, { now });
  const key = briefingKey(ctx, now);
  const [cached, settings] = await Promise.all([
    AiText.findOne({ companyId: ctx.companyId, kind: 'briefing', key }).lean(),
    getAiSettings(),
  ]);
  const answer = (doc, extra = {}) => ({
    briefing: doc
      ? guard(doc.json, evidence)
      : { headline: 'Today so far', narrative: null, actions: [], evidence: present(evidence).slice(0, 4) },
    evidence,
    model: doc?.model ?? null,
    at: doc?.at ?? null,
    mock: Boolean(doc?.mock),
    stale: false,
    ...extra,
  });
  const ttlMs = (settings.briefingTtlHours ?? 4) * HOUR;
  if (cached && !refresh && now - cached.at < ttlMs) return answer(cached);

  const input = {
    company: { name: ctx.company?.name, currency: ctx.company?.currency },
    scope: { label: (ctx.plantLock && plantName(ctx, ctx.plantLock)) || ctx.company?.name || 'All plants' },
    at: now.toISOString(),
    evidence: numbersOf(evidence),
  };
  const flightKey = `${ctx.companyId}|${key}`;
  try {
    if (!inflight.has(flightKey)) {
      inflight.set(
        flightKey,
        writeText(ctx, key, input, now).finally(() => inflight.delete(flightKey)),
      );
    }
    return answer(await inflight.get(flightKey));
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    return answer(cached, { stale: Boolean(cached), aiError: { code: err.code, message: err.message } });
  }
};

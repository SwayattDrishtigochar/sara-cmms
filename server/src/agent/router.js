import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { toJsonSchema } from './declarations.js';
import { getLlm } from './llm.js';
import { GROUP_HELP, groupsFor, LOADABLE_GROUPS } from './tools/registry.js';

/** Intent/complexity router (phase 4 §4): one cheap structured call, keyword heuristics when it fails. */

export const INTENTS = [
  'smalltalk',
  'lookup',
  'analytics',
  'timeseries',
  'diagnosis',
  'write',
  'report',
  'planning',
  'unclear',
];
export const TIERS = ['fast', 'balanced', 'deep'];
const DEEP_INTENTS = new Set(['diagnosis', 'report', 'write', 'planning']);

export const decisionSchema = z.object({
  intent: z.enum(INTENTS),
  complexity: z.enum(['low', 'medium', 'high']),
  needsInflux: z.boolean(),
  isFollowUp: z.boolean(),
  suggestedTier: z.enum(TIERS),
  groups: z.array(z.enum(LOADABLE_GROUPS)).max(LOADABLE_GROUPS.length),
  confident: z.boolean(),
});
const RESPONSE_SCHEMA = toJsonSchema(decisionSchema);

/** smalltalk / lookup+low → fast; analytics, timeseries, medium → balanced; diagnosis/report/write/planning/high → deep. */
export const tierFor = (d) => {
  if (DEEP_INTENTS.has(d.intent) || d.complexity === 'high') return 'deep';
  if (d.intent === 'smalltalk' || (d.intent === 'lookup' && d.complexity === 'low')) return 'fast';
  return 'balanced';
};

const WRITE =
  /\b(create|add|raise|open a|update|change|set|mark|assign|reassign|close|complete|delete|remove|rename|comment|note:|alert me)\b/;
const INTENT_RULES = [
  [
    'smalltalk',
    /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening)|ok|okay|bye|who are you)\b/,
  ],
  ['write', WRITE],
  ['diagnosis', /\b(why|cause|root|diagnos|explain|what happened|reason for|wrong with)\b/],
  ['planning', /\b(plan|schedule|capacity|when can|slot|window for)\b/],
  ['report', /\b(summar|report|csv|export|overview|download)\b/],
  [
    'timeseries',
    /\b(plot|chart|graph|trend|series|over time|last \d+ (hours?|minutes?)|temperature|vibration|pressure|energy|kwh|power|consumption)\b/,
  ],
  [
    'analytics',
    /\b(compare|vs|versus|most|top|group(ed)? by|by (asset|priority|status|reason|category|shift)|breakdown|average|total|rate|oee|per )\b/,
  ],
  [
    'lookup',
    /\b(how many|count|list|show|which|who|what|status|open|due|overdue|find|get|is there|are there)\b/,
  ],
];
const GROUP_HINTS = {
  maintenance:
    /\b(work ?orders?|wo-?\d*|pms?\b|preventive|calibrations?|spares?|parts?|stock|maintenance|technician|overdue|due)\b/,
  production:
    /\b(job ?cards?|jc-?\d*|rejections?|rejected|downtime|stopped|oee|production|produced|shift output|target)\b/,
  telemetry:
    /\b(energy|kwh|power|temperature|temp|vibration|pressure|current|voltage|plot|chart|trend|live|latest|reading|parameters?|timeline|shots?|cycle time|oil|status of)\b/,
  health: /\b(health|anomal|alert|abnormal|wrong|deviat)\b/,
  people: /\b(check(ed)?[ -]?in|attendance|breaks?|who came|present today)\b/,
  write: WRITE,
  planning:
    /\b(plan(s|ning)?|schedul(e|ed|ing)|capacity|gantt|maintenance window|maintenance plan|production plan|operators?|technicians?|doable|slots?|due (by|on)|deliver|when can)\b/,
  // ₹ is not a word character, so it sits outside the \b group.
  cost: /₹|\b(costs?|spend|spent|rupees|budget|expensive|tariff|alert me)\b/,
  kpi: /\b(kpis?|dashboard|heatmap|gauge|metric card|build a (chart|graph|card))\b/,
};

/** Keyword classification used when the router model is unavailable or answers badly. */
export const heuristicRoute = (text) => {
  const t = String(text ?? '').toLowerCase();
  const intent = INTENT_RULES.find(([, rx]) => rx.test(t))?.[0] ?? 'unclear';
  const groups = Object.entries(GROUP_HINTS)
    .filter(([, rx]) => rx.test(t))
    .map(([g]) => g);
  const complexity =
    intent === 'smalltalk'
      ? 'low'
      : DEEP_INTENTS.has(intent)
        ? 'high'
        : groups.length > 1 || /\b(compare|vs|versus|and why)\b/.test(t)
          ? 'medium'
          : 'low';
  const isFollowUp =
    /^(and|also|what about|only|sort|export|same|now|then)\b/.test(t) ||
    (t.length < 30 && /\b(that|those|it|them|last week|this week)\b/.test(t));
  const decision = {
    intent,
    complexity,
    needsInflux: groups.includes('telemetry'),
    isFollowUp,
    groups,
    confident: false,
    heuristic: true,
  };
  return { ...decision, suggestedTier: tierFor(decision) };
};

const ROUTER_SYSTEM = (groups) =>
  `You classify one user message for SARA, an AI assistant inside a maintenance/production system (CMMS). Return JSON only.
intent: smalltalk | lookup (one list/count) | analytics (grouping, comparison) | timeseries (telemetry over time, plots) | diagnosis (why, root cause) | write (create/update/delete/status/comment) | report (summaries, exports) | planning | unclear.
complexity: low | medium | high. needsInflux: true when live machine values, energy or telemetry are needed.
isFollowUp: true when the message depends on the previous turns ("and last week?", "only plant Pune", "export that").
suggestedTier: fast | balanced | deep. groups: the tool groups needed, from ${groups.map((g) => `${g} (${GROUP_HELP[g]})`).join('; ')}. confident: false when unsure.`;

const routerInput = (history, text, ctx) => {
  const lines = history
    .slice(-12)
    .map((h) => `${h.role === 'user' ? 'User' : 'SARA'}: ${String(h.text ?? '').slice(0, 300)}`);
  return `Modules enabled: ${ctx.modules.join(', ')}.\n${lines.length ? `Recent turns:\n${lines.join('\n')}\n` : ''}New message: ${text}`;
};

/**
 * `{ intent, complexity, needsInflux, isFollowUp, suggestedTier, groups, confident, tier, pinned }`.
 * A tier pinned on the conversation wins; otherwise the tier map decides.
 */
export const route = async ({ ctx, conversation, text, history = [] }) => {
  const pinned =
    conversation?.tierPreference && conversation.tierPreference !== 'auto'
      ? conversation.tierPreference
      : null;
  const available = groupsFor(ctx);
  let decision;
  try {
    const llm = await getLlm();
    const { json } = await llm.generate({
      tier: 'router',
      purpose: 'router',
      companyId: ctx.companyId,
      system: ROUTER_SYSTEM(available),
      contents: routerInput(history, text, ctx),
      schema: RESPONSE_SCHEMA,
      mockInput: { text, groups: available },
    });
    const parsed = decisionSchema.safeParse(json);
    if (!parsed.success) throw new Error('the router returned an invalid decision');
    decision = { ...parsed.data, heuristic: false };
  } catch (err) {
    logger.warn({ err: err.message }, 'router fell back to heuristics');
    decision = heuristicRoute(text);
  }
  decision.groups = decision.groups.filter((g) => available.includes(g));
  const mapped = tierFor(decision);
  return {
    ...decision,
    suggestedTier: decision.suggestedTier ?? mapped,
    tier: pinned ?? mapped,
    pinned: Boolean(pinned),
  };
};

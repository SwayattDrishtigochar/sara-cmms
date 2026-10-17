import { z } from 'zod';
import { toDeclaration } from '../agent/declarations.js';
import { getTool, groupsFor, toolsFor } from '../agent/tools/registry.js';

/** Voice tools (phase 8 §3.3): every permitted group at connect, minus load_tools, plus confirm/reject. */

export const MAX_VOICE_TOOLS = 64;

/** Voice-only; handled by the session (§3.4), never run through execute(). */
export const VOICE_CONTROL = [
  {
    name: 'confirm_action',
    group: 'voice',
    description:
      'Runs the pending change the user just agreed to. Call it only after the user clearly said yes to the change you described. Example: { actionId: "<actionId from the awaiting_confirmation answer>" }.',
    schema: z.object({ actionId: z.string().min(1).max(60) }),
  },
  {
    name: 'reject_action',
    group: 'voice',
    description: 'Cancels the pending change when the user says no. Example: { actionId: "<actionId>" }.',
    schema: z.object({ actionId: z.string().min(1).max(60) }),
  },
];
export const CONTROL_NAMES = new Set(VOICE_CONTROL.map((t) => t.name));

/** Registry tools this user may call by voice, then the two control tools. */
export const voiceTools = (ctx) => [
  ...toolsFor(ctx, groupsFor(ctx)).filter((t) => t.name !== 'load_tools'),
  ...VOICE_CONTROL,
];
export const voiceDeclarations = (ctx) => voiceTools(ctx).map(toDeclaration);

/** Live answers (same texts as the chat loop where the case exists there). */
export const VOICE_ERRORS = Object.freeze({
  loadTools: { error: 'Every tool is already available in voice' },
  oneChange: {
    error: 'one change at a time',
    hint: 'Ask for this change again after the user confirms the first one',
  },
  waiting: { error: 'A change is waiting for the user. Ask them to confirm or reject it first.' },
  budget: { error: 'The tool budget of this answer is used up: answer now with what you have.' },
  noAction: { error: 'No such pending change, or the user has not answered yet. Ask them first.' },
});

/** `{ tool }` for a registry tool this user may run by voice, else `{ error }` for the model. */
export const resolveVoiceTool = (ctx, name) => {
  if (name === 'load_tools') return { error: VOICE_ERRORS.loadTools };
  const known = getTool(name);
  if (!known) return { error: { error: `Unknown tool "${name}"`, hint: 'Use one of the declared tools' } };
  if (!toolsFor(ctx, [known.group]).includes(known))
    return {
      error: {
        error: `${name} is not available to ${ctx.user?.name ?? 'this user'} (role ${ctx.role})`,
        hint: 'Explain this to the user and offer to draft the details instead',
      },
    };
  return { tool: known };
};

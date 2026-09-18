// The one place that decides who may do what to a project.
//
// Every data route asks here before it touches anything, so the rules can change
// without hunting for call sites. An actor is { id, login, role }, where `role`
// is that person's membership of THIS project, or null when they have none.
//
// Today there is no sign-in: the server only starts on a loopback address (see
// config.mjs), so whoever reaches it is the developer at their own machine. Reads
// are therefore open, and writes need an actor, which only tests supply.

export const ACTIONS = Object.freeze({ READ: 'project.read', WRITE_HUMAN: 'human.write' });

const WRITERS = new Set(['admin', 'developer', 'answerer']);

/**
 * @param {{id: string, login: string, role: string|null}|null} actor
 * @param {string} action  one of ACTIONS
 * @returns {boolean}
 */
export function authorize(actor, action) {
  if (action === ACTIONS.READ) return true;
  if (action === ACTIONS.WRITE_HUMAN) return Boolean(actor && WRITERS.has(actor.role));
  return false;
}

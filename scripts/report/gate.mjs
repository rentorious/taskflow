// The claim rule: may a batch be started, and if not, why.
//
// This is the single source for that decision. model.mjs uses `blocksClaim` to
// derive lanes; `taskflow claim` runs `evaluateClaim` over the built model, so
// "Ready" is what claim takes by construction. Pure, and imports nothing: the
// hosted server runs the same function inside its claim transaction.

/** Process exit codes of `taskflow claim`. 4 is reserved for the hosted server being unreachable. */
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, QUESTIONS: 2, LOCKED: 3, UNREACHABLE: 4, DEPS: 5, NOTHING: 6, COMPLETE: 7 });

const COMPLETE = new Set(['pr-created', 'done']);

/**
 * A blocking question holds its batch until it is answered or dropped. "sent"
 * is not an answer, and an answer to a question that was reworded since does
 * not count until the developer confirms it still applies.
 */
export function blocksClaim(item) {
  return item.kind === 'question' && item.blocking === true && item.state !== 'handled';
}

function questionsOf(model, batch) {
  return (batch.blockingItemIds ?? []).map((id) => model.inbox[id]).filter(Boolean).map((item) => ({
    id: item.id,
    taskId: item.subject.id,
    title: item.title,
    state: item.state,
    to: item.to ?? null,
  }));
}

function whyNot(model, batch) {
  return { key: batch.key, lane: batch.lane, reason: batch.laneReason ?? null, blockedBy: batch.blockedBy, questions: questionsOf(model, batch) };
}

/**
 * @param {object} model   the view model from buildModel
 * @param {object} [want]
 * @param {string|null} want.batchKey  null = auto-claim
 * @param {boolean} want.stack   proceed on unfinished dependencies by stacking on their branches
 * @param {boolean} want.resume  re-enter a batch this developer already holds
 * @returns {{exit:number, batchKey:string|null, candidates:string[], questions:object[], deps:object[], resume:boolean, relock:boolean, resumable:boolean, staleLock:boolean, waiting:object[], message:string}}
 */
export function evaluateClaim(model, { batchKey = null, stack = false, resume = false } = {}) {
  const base = { exit: EXIT.OK, batchKey, candidates: [], questions: [], deps: [], resume: false, relock: false, resumable: false, staleLock: false, waiting: [], message: '' };
  const batches = model.batches ?? {};

  if (!batchKey) {
    // In claim order. The caller walks the list, because another session can win the lock first.
    const candidates = [...(model.laneOrder?.ready ?? [])];
    if (candidates.length) return { ...base, candidates, message: `Next in line: ${candidates[0]}.` };
    const waiting = Object.values(batches).filter((b) => !COMPLETE.has(b.status) && b.lane !== 'stale').map((b) => whyNot(model, b));
    return { ...base, exit: EXIT.NOTHING, waiting, message: 'No batch can be claimed right now.' };
  }

  const batch = batches[batchKey];
  if (!batch) {
    return { ...base, exit: EXIT.USAGE, message: `No batch called ${batchKey}. Known batches: ${Object.keys(batches).join(', ') || 'none'}.` };
  }
  if (COMPLETE.has(batch.status)) return { ...base, exit: EXIT.COMPLETE, message: `${batchKey} is already complete (${batch.status}).` };
  if (batch.lane === 'stale') return { ...base, exit: EXIT.COMPLETE, message: `${batchKey} went stale: its tasks left "to do" in the provider.` };

  const questions = questionsOf(model, batch);
  const held = batch.status === 'in-progress';

  if (batch.locked && !(held && resume)) {
    return {
      ...base,
      exit: EXIT.LOCKED,
      resumable: held,
      staleLock: !held && batch.laneReason === 'stale-lock',
      message: held
        ? `${batchKey} is in progress under an existing claim. Re-run with --resume to continue it.`
        : batch.laneReason === 'stale-lock'
          ? `${batchKey} is locked but was never started. Release it, then claim it again.`
          : `${batchKey} is being claimed by another session right now.`,
    };
  }

  // Questions are checked on their own, not through the lane: a batch can wait on a
  // dependency and on answers at once, and --stack only waives the dependency.
  if (questions.length) {
    return { ...base, exit: EXIT.QUESTIONS, questions, message: `${batchKey} has ${questions.length} blocking question${questions.length === 1 ? '' : 's'} without an answer.` };
  }

  if (!held && batch.blockedBy.length) {
    const deps = batch.dependsOn.filter((d) => !d.satisfied).map((d) => ({ key: d.key, exists: d.exists, stale: d.stale, branch: batches[d.key]?.branch ?? null }));
    const stackable = deps.every((d) => d.branch);
    if (!stack || !stackable) {
      return {
        ...base,
        exit: EXIT.DEPS,
        deps,
        message: stack
          ? `${batchKey} cannot stack: ${deps.filter((d) => !d.branch).map((d) => d.key).join(', ')} has no branch yet.`
          : `${batchKey} depends on ${deps.map((d) => d.key).join(', ')}, which is not complete. Re-run with --stack to build on its branch.`,
      };
    }
    return { ...base, candidates: [batchKey], deps, message: `Stacking ${batchKey} on ${deps.map((d) => d.branch).join(', ')}.` };
  }

  // In progress with no lock: a session died after starting. Take the lock back and carry on.
  if (held) return { ...base, candidates: [batchKey], resume: true, relock: !batch.locked, message: `Resuming ${batchKey}.` };
  return { ...base, candidates: [batchKey], message: `${batchKey} is claimable.` };
}

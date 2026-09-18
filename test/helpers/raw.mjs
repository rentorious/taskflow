// An in-memory RawCycle, for rules that need no files on disk.

export const MIN = 60 * 1000;

export function task(id, { batch = null, confidence = 'high', needs, ...rest } = {}) {
  return {
    name: `Task ${id}`,
    url: `https://tracker.example.com/t/${id}`,
    priority: 'normal',
    classification: { area: 'storefront', type: 'feature', complexity: 'small', confidence, implementable: 'yes' },
    batch,
    ...(needs === undefined ? {} : { needs }),
    ...rest,
  };
}

export const question = (key, { blocking = true, title = `Ask about ${key}`, text = `What should ${key} do?`, ...rest } = {}) =>
  ({ key, kind: 'question', title, text, to: 'Mara', blocking, ...rest });

export const batchFile = (status, taskIds, { branch = null, taskStatus = 'planned' } = {}) =>
  ({ exists: true, unreadable: false, mtimeMs: 0, data: { status, branch, pr_url: null, tasks: Object.fromEntries(taskIds.map((id) => [id, { status: taskStatus, commit_shas: [] }])) } });

/**
 * @param {object} spec
 * @param {object} spec.tasks     id -> index task entry
 * @param {object} spec.batches   key -> { tasks, depends_on }
 * @param {object} [spec.files]   key -> batchFile(...)
 * @param {object} [spec.locks]   key -> lock mtime in ms
 */
export function rawCycle({ tasks, batches, files = {}, locks = {}, isArchive = false }) {
  return {
    cycle: { id: isArchive ? 'old' : 'live', isArchive, dir: '/nowhere', indexFile: 'state.sam.json', slug: 'sam', stateFiles: ['state.sam.json'] },
    index: {
      schema_version: 3,
      last_triage: '2026-02-01',
      tasks,
      batches: Object.fromEntries(Object.entries(batches).map(([key, b]) => [key, { name: key, suggested_branch: `feat/${key}`, depends_on: [], ...b }])),
    },
    batchFiles: files,
    locks: Object.fromEntries(Object.entries(locks).map(([key, mtimeMs]) => [key, { mtimeMs }])),
    plans: {},
    attachments: {},
    summaryFile: null,
    config: null,
    problems: [],
  };
}

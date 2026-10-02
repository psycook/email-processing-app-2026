import type { ProcessEvent, ProcessEventPage } from './types'

export function mergeEventPage(previous: ProcessEvent[], page: ProcessEventPage, snapshotRevision: number) {
  const events = new Map<string, ProcessEvent>()
  for (const event of [...previous, ...page.events]) {
    if (event.processId !== page.processId) throw new Error('Event page belongs to a different process.')
    if (event.projectionRevision <= snapshotRevision) events.set(event.eventId, event)
  }
  // A refresh starts a new upper-revision paging session, even if the old
  // session was exhausted. Retained records are deduplicated, not its cursor.
  return { events: [...events.values()], nextCursor: page.nextCursor }
}

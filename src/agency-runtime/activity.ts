import { eventsSince, readEvents } from '../activity/log.ts'
import { isRefreshDue } from '../board/snapshot.ts'
import { isIndexStale } from '../usage/run.ts'
import type { RuntimeDeps } from './handle.ts'
import type { Activity, ActivityRequest } from './types.ts'

/**
 * What the team did since a time. The call only reads the small log of the last 24 hours, so it is as cheap as `view`; the log is filled in the
 * background (the board refresh writes board events, the transcript reader writes messages), and this call starts those when they are due.
 */
export function activity(request: ActivityRequest, deps: RuntimeDeps): { readonly result: Activity } {
  const { p, config, now } = deps
  if (isRefreshDue(p, config, now)) deps.spawnRefresh()
  if (isIndexStale(p, now)) deps.spawnUsageIndex()
  const { events, truncated } = eventsSince(readEvents(p.activityLog), new Date(request.since), request.limit, now)
  return { result: { org: request.org, team: request.team, generatedAt: now.toISOString(), events, truncated } }
}

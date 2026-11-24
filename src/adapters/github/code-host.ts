import type { Config } from '../../config.ts'
import { cachedProbe } from '../../dispatch/progress.ts'
import type { CodeHost } from '../../ports/index.ts'
import { githubProbe } from './activity.ts'
import { ghWithin, type GhRun } from './gh.ts'
import { LINK_GH_TIMEOUT_MS, linkBranchWith } from './linked-branch.ts'
import { fetchPrBody, listOpenPrs, referencedLabels } from './pull-requests.ts'

/** The PR body is read inside a hook, so it is cut off at 15 seconds to avoid making anything wait too long. */
const PR_BODY_TIMEOUT_MS = 15_000

/**
 * Handles PRs and branches on GitHub. Work marks are reused so that the same issue is not read many times in a short span.
 * Calls made inside a hook and inside the handover lock (the PR body, preparing the branch) use gh with its time limited by within.
 */
export function githubCodeHost(run: GhRun, config: Config, within: (timeoutMs: number) => GhRun = ghWithin): CodeHost {
  return {
    openPullRequests: (repo) => listOpenPrs(run, repo),
    referencedIssues: (prLabel, repo) => {
      const body = fetchPrBody(within(PR_BODY_TIMEOUT_MS), prLabel, repo)
      return body === null ? null : referencedLabels(body, repo)
    },
    prepareBranch: linkBranchWith(within(LINK_GH_TIMEOUT_MS), config),
    activity: cachedProbe(githubProbe(run)),
  }
}

import type { Config } from '../../config.ts'
import { cachedProbe } from '../../dispatch/progress.ts'
import type { CodeHost } from '../../ports/index.ts'
import { githubProbe } from './activity.ts'
import { ghWithin, type GhRun } from './gh.ts'
import { LINK_GH_TIMEOUT_MS, linkBranchWith } from './linked-branch.ts'
import { fetchPrBody, listOpenPrs, referencedLabels } from './pull-requests.ts'

/** フックの中で PR の本文を読むので、待たせすぎないよう 15 秒で打ち切る。 */
const PR_BODY_TIMEOUT_MS = 15_000

/**
 * PR とブランチを GitHub で扱う。作業の印は、同じ issue を短い間に何度も読まないよう、使い回す。
 * フックの中と渡しの錠の中で呼ぶもの (PR の本文、ブランチの用意) は、within で時間を絞った gh を使う。
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

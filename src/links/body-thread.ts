import type { BodyThread, IssueThread } from '../ports/index.ts'

/** The body side of an issue thread when it has all of it, otherwise null (the tracker cannot rewrite bodies, so there is nothing to link into). */
export function bodyThreadOf(thread: IssueThread): BodyThread | null {
  const { openIssues, read, writeBody } = thread
  return openIssues === undefined || read === undefined || writeBody === undefined ? null : { openIssues, read, writeBody }
}

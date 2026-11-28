import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseBoardCommands, shellPatterns } from '../src/adapters/github/action-reader.ts'
import { referencedLabels } from '../src/adapters/github/pull-requests.ts'
import { applyCommands, checkGuard, countDoing, mergeContext } from '../src/board/commands.ts'
import { isEpic } from '../src/board/rules.ts'
import { config, issue, pr, snapshot } from './helpers.ts'

const parse = (command: string) => parseBoardCommands(command, config)

describe('parseBoardCommands', () => {
  it('reads the number and Status of set-status', () => {
    assert.deepEqual(parse('./set-status 123 "In Progress"'), [
      { kind: 'set-status', label: 'app#123', status: 'In Progress' },
    ])
  })

  it("normalizes the spelling of an English Status to the board's label", () => {
    assert.deepEqual(parse('./set-status 5 InProgress'), [{ kind: 'set-status', label: 'app#5', status: 'In Progress' }])
  })

  it('reads several commands joined with &&', () => {
    const commands = parse('cd t && ./set-status 1 Done && ./set-assignee 1 None; ./set-reason 2 "External wait" 2026-10-07')
    assert.deepEqual(commands, [
      { kind: 'set-status', label: 'app#1', status: 'Done' },
      { kind: 'set-assignee', label: 'app#1', assignee: null },
      { kind: 'set-reason', label: 'app#2', reason: 'External wait', since: '2026-10-07' },
    ])
  })

  it('reads the assignee name wrapped in quotes', () => {
    assert.deepEqual(parse('set-assignee 9 "Another session"'), [
      { kind: 'set-assignee', label: 'app#9', assignee: 'Another session' },
    ])
  })

  it('reads the Status and targets of bulk-status', () => {
    assert.deepEqual(parse('bulk-status Release app#1 app#2'), [
      { kind: 'bulk-status', labels: ['app#1', 'app#2'], status: 'Release' },
    ])
  })

  it('reads merge-pr, gh pr merge, and gh issue close', () => {
    assert.deepEqual(parse('merge-pr example-org/app 210 abc123'), [
      { kind: 'merge-pr', label: 'app#210', repo: 'example-org/app' },
    ])
    assert.deepEqual(parse('gh pr merge 22 -R example-org/app-mobile --squash'), [
      { kind: 'merge-pr', label: 'app-mobile#22', repo: 'example-org/app-mobile' },
    ])
    // The shape of the merge-pr script (script name, repository, number) also keeps the repository that was pointed at
    assert.deepEqual(parse('merge-pr other-owner/tool 3 abc123'), [{ kind: 'merge-pr', label: 'tool#3', repo: 'other-owner/tool' }])
    // A repository missing from the config's repos is kept as pointed at, not mistaken for defaultRepo
    assert.deepEqual(parse('gh pr merge 3 -R other-owner/tool --squash'), [{ kind: 'merge-pr', label: 'tool#3', repo: 'other-owner/tool' }])
    assert.deepEqual(parse('gh issue close 11 --comment done'), [{ kind: 'close-issue', label: 'app#11' }])
  })

  it('treats a board rewrite that bypasses the script as raw-mutation', () => {
    assert.deepEqual(parse('gh project item-edit --id X --field-id Y --clear'), [{ kind: 'raw-mutation' }])
    assert.deepEqual(parse(`gh api graphql -f query='mutation{updateProjectV2ItemFieldValue(input:{})}'`), [
      { kind: 'raw-mutation' },
    ])
  })

  it('a command unrelated to the board yields nothing', () => {
    assert.deepEqual(parse('git status && ls set-status.bak'), [])
  })
})

describe('applyCommands', () => {
  it('reflects Status, reason, and assignee in the board copy', () => {
    const before = snapshot([issue(1)])
    const after = applyCommands(before, parse('set-status 1 "In Progress" && set-assignee 1 SWE1'), config, '2026-10-08')
    assert.deepEqual([after.items[0]?.status, after.items[0]?.assignee], ['In Progress', 'SWE1'])
    assert.equal(before.items[0]?.status, 'Backlog')
  })

  it('setting a reason makes today the day the block began; setting it to none clears the day', () => {
    const stopped = applyCommands(snapshot([issue(1)]), parse('set-reason 1 "External wait"'), config, '2026-10-08')
    assert.deepEqual([stopped.items[0]?.reason, stopped.items[0]?.since], ['External wait', '2026-10-08'])
    const resumed = applyCommands(stopped, parse('set-reason 1 None'), config, '2026-10-08')
    assert.deepEqual([resumed.items[0]?.reason, resumed.items[0]?.since], ['None', null])
  })

  it('changes the state of a closed issue and a merged PR', () => {
    const after = applyCommands(snapshot([issue(1), pr(2, { state: 'OPEN' })]), parse('gh issue close 1 && gh pr merge 2'), config, '2026-10-08')
    assert.deepEqual(after.items.map((item) => item.state), ['CLOSED', 'MERGED'])
  })

  it('changing the Status of an issue that is not on the board adds an item', () => {
    const after = applyCommands(snapshot([]), parse('set-status 7 Backlog'), config, '2026-10-08')
    assert.deepEqual(after.items.map((item) => [item.number, item.status]), [[7, 'Backlog']])
  })
})

describe('checkGuard', () => {
  const full = snapshot(Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: 'In Progress', assignee: 'SWE1' })))

  it('refuses to increase In Progress when the limit has been reached', () => {
    const reason = checkGuard(snapshot([...full.items, issue(50)]), parse('set-status 50 "In Progress"'), config)
    assert.match(reason ?? '', /10 items are In Progress, at the limit of 10/)
  })

  describe('with epics (issues that have sub-issues) In Progress', () => {
    // three epics, each with a child, and seven real items: ten In Progress by the column, seven that anybody works on
    const epics = [1, 2, 3].map((n) => issue(n, { status: 'In Progress', assignee: 'SWE1', subIssues: 2 }))
    const real = Array.from({ length: 7 }, (_, i) => issue(i + 10, { status: 'In Progress', assignee: 'SWE1' }))
    const board = snapshot([...epics, ...real, issue(50), issue(51), issue(52), issue(53)])

    it('does not count them, so a real item can be moved while the column holds ten', () => {
      assert.equal(countDoing(board, config), 7)
      assert.equal(checkGuard(board, parse('set-status 50 "In Progress"'), config), null)
      assert.equal(checkGuard(board, parse('bulk-status "In Progress" 50 51 52'), config), null)
    })

    it('still refuses when the items that are counted reach the limit, and says which items were counted and which were not', () => {
      const reason = checkGuard(board, parse('bulk-status "In Progress" 50 51 52 53'), config) ?? ''
      assert.match(reason, /^7 items are In Progress, at the limit of 10\. Counted: app#10 .* app#16\. Not counted/)
      const full = snapshot([...epics, ...Array.from({ length: 10 }, (_, i) => issue(i + 10, { status: 'In Progress', assignee: 'SWE1' })), issue(50)])
      const refused = checkGuard(full, parse('set-status 50 "In Progress"'), config) ?? ''
      assert.match(refused, /10 items are In Progress, at the limit of 10\. Counted: app#10 app#11 app#12 app#13 app#14 app#15 app#16 app#17 app#18 app#19\. Not counted, as they have sub-issues: app#1 app#2 app#3\./)
    })

    it('does not count an epic that is moved to In Progress, and does not say "not counted" when there is none', () => {
      const tight = snapshot([...Array.from({ length: 10 }, (_, i) => issue(i + 10, { status: 'In Progress', assignee: 'SWE1' })), issue(60, { subIssues: 3 })])
      assert.equal(checkGuard(tight, parse('set-status 60 "In Progress"'), config), null)
      const reason = checkGuard(snapshot([...tight.items, issue(61)]), parse('set-status 61 "In Progress"'), config) ?? ''
      assert.doesNotMatch(reason, /Not counted/)
      assert.match(reason, /Counted: app#10 .* app#19\./)
    })

    it('knows an epic by the children that name it as their parent too, when the sub-issues were not read', () => {
      const withChildren = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' }), issue(2, { status: 'In Progress', assignee: 'SWE1', epic: 'app#1' })])
      assert.deepEqual([countDoing(withChildren, config), isEpic(withChildren.items[0] as never, withChildren.items), isEpic(withChildren.items[1] as never, withChildren.items)], [1, true, false])
    })
  })

  it('allows setting an issue that is already In Progress to In Progress again', () => {
    assert.equal(checkGuard(full, parse('set-status 3 "In Progress"'), config), null)
  })

  it('refuses an attempt to give a PR a Status', () => {
    const reason = checkGuard(snapshot([pr(102)]), parse('set-status 102 "In Progress"'), config)
    assert.match(reason ?? '', /A PR must not have a Status/)
  })

  it('does not block when SCRUM_GUARD=off is set', () => {
    const command = 'SCRUM_GUARD=off set-status 50 "In Progress"'
    assert.equal(checkGuard(snapshot([...full.items, issue(50)]), parse(command), config, command), null)
  })
})

describe('referencedLabels and mergeContext', () => {
  it('picks up #number and repository#number from the body', () => {
    const body = '#11 continues. Also app-mobile#22. Ignore https://x/y#4, Closes #230'
    assert.deepEqual(referencedLabels(body, 'example-org/app'), ['app#11', 'app-mobile#22', 'app#230'])
  })

  it('lists the current state of issues that are on the board', () => {
    const board = snapshot([issue(11, { status: 'In Progress', assignee: 'SWE1' })])
    const text = mergeContext(board, 'app#220', ['app#11', 'app#999'], config) ?? ''
    assert.match(text, /app#220 was merged/)
    assert.match(text, /app#11 Status=In Progress reason=None assignee=SWE1/)
    assert.doesNotMatch(text, /app#999/)
  })

  it('returns null when no board issue is touched', () => {
    assert.equal(mergeContext(snapshot([]), 'app#1', ['app#2'], config), null)
  })
})

describe('script configuration', () => {
  const bare = { ...config, scripts: {} }

  it('does not read script calls when no script is configured', () => {
    assert.deepEqual(parseBoardCommands('set-status 1 "In Progress" && merge-pr example-org/app 2', bare), [])
  })

  it('reads gh commands even when no script is configured', () => {
    assert.deepEqual(parseBoardCommands('gh issue close 3 && gh pr merge 4', bare), [
      { kind: 'close-issue', label: 'app#3' },
      { kind: 'merge-pr', label: 'app#4', repo: 'example-org/app' },
    ])
  })

  it('reads the assignee as is when no word for emptying a value is configured', () => {
    const noClear = { ...config, scripts: { setAssignee: 'set-assignee' } }
    assert.deepEqual(parseBoardCommands('set-assignee 9 None', noClear), [{ kind: 'set-assignee', label: 'app#9', assignee: 'None' }])
  })
})

describe('shellPatterns', () => {
  it('puts the configured script name into the command pattern for which the hook starts node', () => {
    const patterns = shellPatterns(config)
    assert.match('set-status 1 "In Progress"', new RegExp(patterns.post))
    assert.match('gh pr merge 3', new RegExp(patterns.post))
    assert.doesNotMatch('git status', new RegExp(patterns.post))
    assert.match('bulk-status "In Progress" app#1', new RegExp(patterns.pre))
    assert.doesNotMatch('set-reason 1 None', new RegExp(patterns.pre))
  })

  it('treats symbols in the script name literally inside the pattern', () => {
    const patterns = shellPatterns({ ...config, scripts: { setStatus: 'update.sh' } })
    assert.doesNotMatch('updateXsh', new RegExp(patterns.pre))
  })

  it('when there is no script that changes Status, no check before writing is needed', () => {
    assert.equal(shellPatterns({ ...config, scripts: {} }).pre, '')
  })
})

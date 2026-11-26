# Releasing

The harness is released as versions of the whole repository, made from the Conventional Commits titles of the merged pull requests by [release-please](https://github.com/googleapis/release-please). Nobody edits the version or `CHANGELOG.md` by hand. There is nothing to build or attach: a release is a tag, a GitHub Release with the changelog section as its notes, and the version in `package.json`.

## The version number

Versions are `0.MINOR.PATCH` until the first 1.0:

| Titles since the last release | Next version |
|---|---|
| a `feat`, or a breaking change (`feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer) | the minor number goes up (0.2.0 to 0.3.0) |
| only `fix` and `perf` | the patch number goes up (0.2.0 to 0.2.1) |
| only `docs`, `test`, `chore`, `ci`, `build`, `style`, `refactor` | no release is proposed |

A `refactor` is listed in the changelog, but it does not call for a release by itself. Before 1.0, a breaking change raises the minor number, as a new feature does, so read the changelog before updating across a minor number.

## How a release is made

1. Merge pull requests as usual. The pull request title is the commit title (a squash merge), so it must follow Conventional Commits.
2. release-please keeps one open pull request, **chore: release X.Y.Z**, that raises the version in `package.json` and adds the new section of `CHANGELOG.md`. It updates itself after each merge to `main`.
3. To release, merge that pull request. release-please then tags `vX.Y.Z` and makes the GitHub Release.

## Settings it needs

- Settings, Actions, General: **Allow GitHub Actions to create and approve pull requests** is on (release-please opens its pull request with the workflow's own token). The default token permissions stay read-only; the workflow asks for what it needs.
- A pull request made with the workflow's own token does not start other workflows, so the release pull request has no CI run. It changes only the version and the changelog.
- The first release, 0.1.0, counted the pull requests merged from the day releases were set up; the history before it is in `git log`.

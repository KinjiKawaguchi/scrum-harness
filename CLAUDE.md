# CLAUDE.md

Conventions for everyone (people and agents) working in this repository.

## Language

English is the official language of this repository: code, comments, doc comments, test names, CLI output, error messages, docs, commit messages, issues, and pull requests. Write all new text in English. Japanese text that remains in existing files is being translated; see the translation issue (#3).

## Public repository hygiene

This repository is public. Never write names or details that point at a specific company, customer, person, or internal event: no real organization or product names, customer identifiers, people's names, real issue numbers from other projects, internal tool names, credentials, account IDs, or local paths. Use fictional examples (`acme`, `app`, `alice`, `bob`, `#123`). Read your diff for this before every push.

The source holds no values of a specific board or team. Such values live only in the configuration file (`config.example.json` shows the shape with fictional values).

## Workflow

- Branch from `origin/main` (`feat/...`, `fix/...`, `refactor/...`, `docs/...`, `chore/...`) and open a pull request to `main`.
- Commit messages and pull request titles follow Conventional Commits and say why the change is needed.
- Pull request body: **Why**, **What**, and **How** only when the implementation needs explaining. End with `Closes #N` on its own line when the pull request completes an issue.
- Before opening a pull request: `pnpm run typecheck` and `pnpm test`.

# Contributing to High Command

## Set up

1. Install Claude Code 2.1.288 or later and TypeScript 7.0 or later (the version the checks use).
2. Clone the repository and create a branch.
3. Load the mod once with `claude --plugin-dir .` from the repository folder, then exit. Claude Code writes `.claude-plugin/types/` and `tsconfig.json`, which `.gitignore` keeps out of commits.

## Check a change

Run these from the repository folder. Each must pass before you open a pull request.

```sh
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
tsc -p .
```

`claude plugin validate .claude-plugin/plugin.json` warns that `CLAUDE.md` at the plugin root is not loaded as project context. That is expected: `CLAUDE.md` is for coding agents that work on this repository.

## Test a change

The repository holds no test files. Test your change with Claude Code's test kit:

1. Write test files (`*.test.ts`) in a `tests/` folder. They import `test`, `expect`, and `mock` from `claude-code/testing`.
2. Run `claude plugin test .`. Every test must pass.
3. Keep the test files out of your commits.

Test the parsers, the state changes, and each main path a person takes: a message arrives, a message goes out, `/highcommand`, the pane, and the band. Run drawing tests on the `terminal` and `desktop` surfaces.

## Write a change

- Keep `$` in `hooks/register.tsx`. Every other module is a pure function of its inputs.
- Every failure gives a line of the form `high-command: <event>: <cause>`.
- Keep each export used, each branch reachable, and each piece of logic in one place.
- Use invented names in examples and tests.

## Submit

Open a pull request against `main` with a short description of the change and the commands you ran.

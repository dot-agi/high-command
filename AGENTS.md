# Agent instructions for High Command

## Install and update

Install from a shell with Claude Code 2.1.292 or later. The second part turns on auto-update. It runs only when the install succeeds and the marketplace entry exists:

```sh
claude plugin install high-command --marketplace dot-agi/high-command --scope user --json \
  && f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
  && jq -e --arg name high-command '.extraKnownMarketplaces[$name].source' "$f" > /dev/null \
  && tmp=$(mktemp "$f.XXXXXX") \
  && { jq --arg name high-command '.extraKnownMarketplaces[$name].autoUpdate = true' "$f" > "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; false; }; }
```

Claude Code 2.1.288 to 2.1.291 has no `--marketplace` option. Add the marketplace first, then turn on auto-update:

```sh
claude plugin marketplace add dot-agi/high-command --scope user --json \
  && claude plugin install high-command@high-command --scope user --json \
  && f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
  && jq -e --arg name high-command '.extraKnownMarketplaces[$name].source' "$f" > /dev/null \
  && tmp=$(mktemp "$f.XXXXXX") \
  && { jq --arg name high-command '.extraKnownMarketplaces[$name].autoUpdate = true' "$f" > "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; false; }; }
```

Auto-update runs only in interactive sessions. A headless job updates at its start, before the session that uses the mod:

```sh
claude plugin update high-command@high-command --json
```

Check the result. The first command prints the installed version. The second prints the latest release:

```sh
claude plugin list --json | jq -r '.[] | select(.id == "high-command@high-command") | "\(.version) enabled=\(.enabled)"' \
  && git ls-remote --tags --refs https://github.com/dot-agi/high-command 'high-command--v*' | sed 's/.*--v//' | sort -V | tail -n 1
```

- On a host with no SSH key for GitHub, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the environment of every `claude` command and session.
- New code loads in the next session, or after `/reload-plugins`. An agent cannot type `/reload-plugins`, so it starts a new session.
- Running `install` again does not update. Use `update`.
- The `mv` replaces the settings file, with mode 600. If `settings.json` is a symbolic link, edit its target instead.

## Layout

| Path | Role |
| --- | --- |
| `hooks/register.tsx` | The hooks module: every hook, the inbox of each conversation in module memory (the source of truth), the copy of the current inbox it writes to `$.state` for drawing and reloads, diagnostics, and button handlers. The only file that uses `$`. |
| `hooks/envelope.ts` | Parses a delivery into entries and peer reports. |
| `hooks/listing.ts` | Reads peer states from a ListAgents listing. |
| `hooks/inbox.ts` | Pure state transforms: append, read marks, roster, threads, recipients. |
| `hooks/summary.ts` | The `/highcommand` text. |
| `hooks/views.tsx` | The pane and band trees, and the check that keeps the band within the engine's drawing bounds. |
| `hooks/text.ts`, `hooks/limits.ts` | Text helpers and bounds. |
| `types/index.d.ts` | The entry, peer, and lane types, and the `PluginState` contract of the `$.state` copy. |
| `tests/` | Local test files (`*.test.ts`) for the test kit. Git does not track them. |

## Commands

- Validate: `claude plugin validate .` and `claude plugin validate .claude-plugin/plugin.json`
- Test: `claude plugin test .` (it needs at least one `*.test.ts` file under the folder)
- Type check: `tsc -p .` (load the mod once with `claude --plugin-dir .` to write the types)

## Rules

- Write `$` only as `$.noun.verb(...)`, or pass it whole to a helper or to `read`/`update`. Never store, spread, compare, or return it.
- Import plugin files by relative, extensionless paths.
- Never declare anything named `h` or `Fragment`; JSX compiles to the global `h`.
- Draw message bodies as `Text`, never `Markdown`. In the `/highcommand` text, write each peer name as a code span.
- Peer names are sender text: read peer-keyed records with `Object.hasOwn`, and write them through `Map` and `Object.fromEntries`.
- Parse peer text in linear time. A regular expression must not repeat a group that can match the same text in two ways.
- Sender labels come from origin fields alone; message text can only lower one. The `suspicious` mark and any sender-claimed priority never reach `/highcommand`, the roster order, or a count.
- The mod never changes, consumes, or refuses a delivery, a prompt, a send, or a tool result, and makes no file, network, process, store, or model call.
- Each failure path gives `high-command: <event>: <cause>`.
- Return a button's work from its `onPress`. A press counts as the person's own input only while that work runs, and only then does `$.ui.open` place the pane below 144 columns.
- Test the parsers, the state changes, and each main path a person takes. Run drawing tests on `terminal` and `desktop`. Keep the suite under one minute.
- Never commit a test file.
- Use invented names in examples and tests; never copy real session data.

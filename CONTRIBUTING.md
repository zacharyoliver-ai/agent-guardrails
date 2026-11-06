# Contributing

Bug reports, false alarms and new guards are all welcome. Please open an issue before a large change.

## Report a false alarm

A guard that refuses safe work gets switched off, so these reports matter. Send the exact command and what you expected. To see what each guard would have refused in your own sessions, with anything shaped like a credential masked:

```
node bin/replay.mjs --since 7d --show
```

## Add or change a tool

A change is finished when all four of these pass.

1. **The tool**, in `hooks/` or `bin/`, with no dependencies. A hook fails open: if it can't read its input or hits an error, it allows the call and writes one line to stderr. A deny reason is written for the agent reading it, and says what to do next.
2. **Its test**, in `test/`. Cover what the tool must refuse and what it must allow.
3. **Its planted faults**, in `proof/faults/<name>.json`. Each one breaks the tool in one exact place, and the tool's own test has to fail against it. Plant at least one fault on each side: one that lets a bad call through, and one that refuses a good call.
4. **Its listing**, in the README's table. A new hook also goes in `lib/hook-table.mjs`; then run `node bin/gen-plugin-hooks.mjs`.

## Before you open a pull request

```
node --test
node bin/proof-matrix.mjs --check
node bin/gen-plugin-hooks.mjs --check
node bin/find-vacuous-tests.mjs
```

CI runs these on Windows, macOS and Linux. If you added or changed a fault, run `node bin/proof-matrix.mjs --write` to refresh [PROOF.md](PROOF.md), and update the fault and tool counts in the README. A test fails if they disagree.

# Results

These tools come from how we build [Awnitboss](https://awnitboss.com), a CRM for real estate agents. AI agents write the code, several at a time. We set the rules, decide what gets built and approve each release. Awnitboss is closed source, and none of its code is in this repo.

Counted from its main branch on November 5, 2026:

| What | Count |
|---|--:|
| Commits on main | 19,360 |
| Merged pull requests | 4,412 |
| Test files | 9,935 |
| Feature contracts | 95 |
| Commits marked for a production release | 481 |
| Checks required before any merge | 4 |

## What has to pass before a merge

1. **Lint** on the files that changed.
2. **Mutation proof** on the tests that changed. Each test has to fail when the code it covers is broken on purpose.
3. **Product check** on the whole build.
4. **Contract proof** for any feature the change touches. A contract lists what the feature must always and never do, and each line names a test that fails on a broken copy.

Merges go through a queue that runs the product and contract checks again on top of the latest main. A change that only breaks alongside another one gets dropped and never lands.

## Replay over real sessions

[replay](../bin/replay.mjs) runs recorded tool calls back through the guards that judge a call on its own: git-guard, secret-guard, bulk-write-gate, foreground-wait and model-ladder. We ran them over more than 1.2 million tool calls from more than 13,000 of our own session transcripts and read a sample of every kind of refusal. Where a kind of refusal hit ordinary work, we changed the guard and added a test and a planted fault for that case. The same command runs on your sessions.

## Where each tool here came from

| How we work on Awnitboss | The tool in this repo |
|---|---|
| An agent has a step budget and writes a hand-off before it runs out | [step-budget](../hooks/step-budget.mjs) |
| Each agent owns its files, and nobody edits another agent's | [file-ownership](../hooks/file-ownership.mjs), [lane-board](../bin/lane-board.mjs) |
| The agent drawing a screen stays on the screen, and the builder ships it | [design-seat](../hooks/design-seat.mjs) |
| Every agent call names a model that fits the job | [model-ladder](../hooks/model-ladder.mjs) |
| A cap on how many agents run at once, per model | [fleet-cap](../hooks/fleet-cap.mjs) |
| Long runs go to the background while the agent keeps working | [foreground-wait](../hooks/foreground-wait.mjs) |
| Named files only in a commit, and no history rewrites | [git-guard](../hooks/git-guard.mjs) |
| Credentials stay out of chat, logs and files | [secret-guard](../hooks/secret-guard.mjs) |
| No write can change a whole protected table | [bulk-write-gate](../hooks/bulk-write-gate.mjs) |
| One rulings file every session reads, and every change reaches running sessions | [decisions-file](../hooks/decisions-file.mjs) |
| A question put to a person stays on a list until they answer it | [decision-ledger](../hooks/decision-ledger.mjs) |
| Lines an agent must never write go back to it once | [never-say](../hooks/never-say.mjs) |
| "Done" needs a check run after the last edit | [proof-required](../hooks/proof-required.mjs) |
| Each feature's always and never lines name a test that fails on a broken copy | [contract-check](../bin/contract-check.mjs) |
| A test only counts if it fails on a planted bug | [planted-fault](../bin/planted-fault.mjs), [find-vacuous-tests](../bin/find-vacuous-tests.mjs) |
| Legal and consent wording is pinned, byte for byte | [pin-check](../bin/pin-check.mjs) |
| Public copy gets read for phrases that sound machine-written | [plain-copy](../bin/plain-copy.mjs) |
| Agent token use gets read daily, and runaways get stopped | [usage-report](../bin/usage-report.mjs) |
| CI minutes are paced against the month's limit | [ci-minutes](../bin/ci-minutes.mjs) |

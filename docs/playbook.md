# How to run many coding agents at once

Ten practices that keep a crowd of agents from stepping on each other. Each one ends with the tool in this repo that enforces it.

1. **Give each agent its own files and worktree.** Two agents in one folder will overwrite each other sooner or later. Hand every agent a lane, a list of paths it may edit, and a separate worktree to edit them in (the [split-the-work](../skills/split-the-work/SKILL.md) skill cuts a task that way). A board that shows who holds which lane saves a lot of asking around. Enforced by [file-ownership](../hooks/file-ownership.mjs) and [lane-board](../bin/lane-board.mjs).

2. **Use the cheapest model that can do the job.** A lookup does not need the largest model, and a security review should not go to the smallest. Make every subagent call name a model, and check the name against the job in its description. The plugin's [agents](../agents/) already pick one each. Enforced by [model-ladder](../hooks/model-ladder.mjs).

3. **Cap steps and how many run at once.** An agent with no step limit will keep going long after it has stopped being useful. Give each one a budget with a warning near the end, so it can write a hand-off while it still can. Put a ceiling on how many subagents run together too. Enforced by [step-budget](../hooks/step-budget.mjs) and [fleet-cap](../hooks/fleet-cap.mjs).

4. **Long work goes in the background.** A full test run in the foreground leaves the agent staring at a spinner. Start it in the background and let the agent pick up the next task. Short runs on a few named files can stay where they are. Enforced by [foreground-wait](../hooks/foreground-wait.mjs).

5. **Write the promise before the code.** For each feature, list what it must always do and never do. Every line names a test, and that test has to fail when the code is broken on purpose. A line with no such test counts as unproven. Enforced by [contract-check](../bin/contract-check.mjs).

6. **Plant a fault in any test you rely on.** Change one line of the code under test so it is wrong, then run the test. If it still passes, it was never checking anything. A second tool lists tests that contain no assertion at all. Enforced by [planted-fault](../bin/planted-fault.mjs) and [find-vacuous-tests](../bin/find-vacuous-tests.mjs).

7. **Stage named files only, and never print a secret.** `git add -A` sweeps up other agents' work, and a token echoed into a log stays there. Block both before they happen, and block statements that rewrite a whole protected table at once. [replay](../bin/replay.mjs) shows how often your own past sessions would have hit these. Enforced by [git-guard](../hooks/git-guard.mjs), [secret-guard](../hooks/secret-guard.mjs) and [bulk-write-gate](../hooks/bulk-write-gate.mjs).

8. **Keep one rulings file that every session reads.** When a person decides something, it goes in one file. Running sessions see each change at their next prompt, so nobody has to say it twice. A design agent can be held to screen files so that its work is easy to review. Enforced by [decisions-file](../hooks/decisions-file.mjs) and [design-seat](../hooks/design-seat.mjs).

9. **Never lose a question, and hold wording that must not drift.** A question put to a person stays on a list until they answer it, and each one carries the agent's recommendation. Legal text is pinned byte for byte. Phrases you never want in a reply are sent back once, and public copy is scanned for machine-sounding habits. A claim of "done" needs a check run after the last edit. Enforced by [decision-ledger](../hooks/decision-ledger.mjs), [pin-check](../bin/pin-check.mjs), [never-say](../hooks/never-say.mjs), [plain-copy](../bin/plain-copy.mjs) and [proof-required](../hooks/proof-required.mjs).

10. **Watch the spend.** Read token use per agent on a schedule, and pace CI minutes against the monthly allowance so the month does not end early. Enforced by [usage-report](../bin/usage-report.mjs) and [ci-minutes](../bin/ci-minutes.mjs).

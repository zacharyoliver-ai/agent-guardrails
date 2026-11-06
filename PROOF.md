# Proof

A planted fault is a bug we put in a tool on purpose, in one exact place. We do it in a throwaway copy of the repo, run the tool's own test, and the test has to fail. If it still passes, the test was too weak to trust, so a passing suite here means something.

Re-run it yourself: `node bin/proof-matrix.mjs --check`. CI runs it on Windows, macOS and Linux on every push.

192 of 192 planted faults are caught, across 28 tools.

## Guards

| Tool | What it guarantees | Bug we planted | Result |
| --- | --- | --- | --- |
| `bulk-write-gate` | A SQL write that would change every row of a table is refused unless the statement carries a bulk-ok comment with a reason. | A heredoc piped into a client is skipped, so cat <<EOF \| psql walks past the gate. | CAUGHT |
|  |  | Every heredoc on a line with a client counts as SQL, so a note written to a file is refused. | CAUGHT |
|  |  | A WHERE clause that is always true, such as 1=1, is accepted as a real filter. | CAUGHT |
|  |  | The bulk-ok comment is ignored, so an approved statement is still refused. | CAUGHT |
|  |  | Protected tables are never matched, so their updates and deletes pass. | CAUGHT |
|  |  | git commands are no longer exempt, so a commit message that mentions SQL is refused. | CAUGHT |
|  |  | TRUNCATE is no longer recognised as a bulk write. | CAUGHT |
|  |  | The PowerShell tool is no longer read, so a delete through Invoke-Sqlcmd passes. | CAUGHT |
|  |  | curl is no longer exempt, so a request body that mentions SQL is refused. | CAUGHT |
|  |  | Every command on a line with a SQL client is scanned, so prose in a neighbouring command is refused. | CAUGHT |
|  |  | SQL files handed to a client with -f or < are never read, so their statements pass. | CAUGHT |
|  |  | A backslash inside an E-string no longer escapes the quote, so the string ends early and a statement hidden after it is missed. | CAUGHT |
|  |  | Text piped into a client is not scanned, so echo piped to psql passes. | CAUGHT |
|  |  | A heredoc is attributed to a client that appears earlier on the same line, so a commit message heredoc is refused. | CAUGHT |
|  |  | GRANT TRUNCATE ON is read as emptying a table named ON. | CAUGHT |
|  |  | The check for prose skips every name after TRUNCATE, so a real one passes. | CAUGHT |
|  |  | xargs is read as the command, so a search it runs is refused as SQL. | CAUGHT |
|  |  | Whatever xargs runs is ignored, so a SQL client behind it passes. | CAUGHT |
|  |  | The value of an xargs flag is read as the command it runs. | CAUGHT |
|  |  | SQL piped through xargs into a client is not checked. | CAUGHT |
| `design-seat` | The design seat edits screen files only and never pushes, opens pull requests or runs tests. | Edits to backend folders are allowed. | CAUGHT |
|  |  | Test files are allowed. | CAUGHT |
|  |  | git push is no longer in the blocked commands. | CAUGHT |
|  |  | The seat is enforced for every session, even without the seat variable. | CAUGHT |
|  |  | Any folder whose name merely ends in a backend name is refused, so a screen file is blocked. | CAUGHT |
| `file-ownership` | An agent can edit only the files its lane owns, and edits inside the lane pass. | Every edit is allowed, whatever the lane owns. | CAUGHT |
|  |  | A lane missing from the owners file is treated as owning everything. | CAUGHT |
|  |  | A path outside the project folder is allowed. | CAUGHT |
|  |  | Every edit is refused, even inside the lane. | CAUGHT |
| `fleet-cap` | A session never has more subagents running at once than the cap for their tier, and finished or stale subagents free their slots. | The cap is off by one, so one extra subagent gets through. | CAUGHT |
|  |  | Entries never expire, so a crashed agent locks the session out for good. | CAUGHT |
|  |  | SubagentStop always frees the oldest entry and ignores the subagent type. | CAUGHT |
|  |  | All sessions share one state file, so their counts mix. | CAUGHT |
|  |  | A call another hook denied never frees its slot, because it is recorded as running. | CAUGHT |
|  |  | A started agent loses its slot after 60 seconds like a pending call. | CAUGHT |
|  |  | SubagentStop ignores the agent id and frees the wrong entry of the same type. | CAUGHT |
| `foreground-wait` | A full test run, a build, a long sleep or a watcher is refused in the foreground so it can go to the background while the agent keeps working. | The limit on named test files is raised from three to thirty, so a run over many files counts as short. | CAUGHT |
|  |  | A call that asks for the background is no longer recognised, so it is judged as a foreground run. | CAUGHT |
|  |  | The sleep threshold is raised to a day, so a long sleep passes. | CAUGHT |
|  |  | A single named test file is no longer enough to count as a short run. | CAUGHT |
|  |  | The PowerShell tool is no longer inspected, so a full test run passes there. | CAUGHT |
|  |  | --watch=false is treated as a watcher and refused. | CAUGHT |
|  |  | --watch=true is accepted along with --watch=false. | CAUGHT |
|  |  | Playwright is judged by file extensions again, so a plain name filter such as checkout is refused. | CAUGHT |
|  |  | A whole-folder word such as tests no longer counts as a full run, so npx playwright test tests passes. | CAUGHT |
|  |  | Jest and Vitest runs are no longer checked, so a full run of either passes. | CAUGHT |
|  |  | A :line suffix no longer makes a name a file, so node --test a.spec.ts:12 counts as a full run. | CAUGHT |
|  |  | A shell variable no longer counts as a file, so node --test $f counts as a full run. | CAUGHT |
|  |  | The braces of ${NAME} are read as a glob, so node --test ${D}/a.test.mjs counts as a full run. | CAUGHT |
|  |  | A --test flag after the script counts as node's own, so a script with its own --test option is refused. | CAUGHT |
|  |  | A value flag's value reads as the script, so node --import x --test passes as an ordinary script run. | CAUGHT |
|  |  | An input redirection counts as a file, so node --test a.test.mjs </dev/null is refused. | CAUGHT |
| `git-guard` | Git commands that discard work or sweep up another agent's files in a shared repository are refused, while commands that name their paths pass. | git add . is no longer treated as staging everything. | CAUGHT |
|  |  | git reset --hard is no longer recognised, because the flag is misspelled in the check. | CAUGHT |
|  |  | The branch-name match loses its end anchor, so pushing a branch such as main-fix is refused. | CAUGHT |
|  |  | The paths after git stash are not read, so git stash push src/a.js is refused like a bare stash. | CAUGHT |
|  |  | A forced push is only caught when the long flag is used, so -f slips through. | CAUGHT |
|  |  | A launcher's flag values are no longer skipped, so the user name after sudo -u is read as the command and the git command behind it goes unchecked. | CAUGHT |
|  |  | eval is no longer unpacked, so a command passed to eval goes unchecked. | CAUGHT |
|  |  | The PowerShell tool is no longer inspected, so git add -A passes there. | CAUGHT |
|  |  | The checked-out branch is ignored, so a bare git push from main is allowed. | CAUGHT |
|  |  | Every push without a refspec is treated as a push of the checked-out branch even when the refspec names another branch. | CAUGHT |
|  |  | A dry run of git clean is no longer recognised, so git clean -nfd is refused. | CAUGHT |
|  |  | A sweep flag refuses every git add even when paths are named, so git add -A src/a.js is blocked. | CAUGHT |
|  |  | git add -u and -uv are no longer treated as a sweep of every tracked change. | CAUGHT |
|  |  | A git stash with no named path is allowed, so git stash push sweeps up everyone's changes. | CAUGHT |
|  |  | git stash push . is allowed, because a whole-directory path is no longer seen as a sweep. | CAUGHT |
|  |  | The value of git stash -m is read as a path, so git stash push -m note passes as if it named a file. | CAUGHT |
|  |  | A cd earlier in the command is ignored, so a bare push from a feature branch is judged by the session's folder. | CAUGHT |
|  |  | An input redirection reads as a named path, so git add -A </dev/null passes. | CAUGHT |
| `hook-io` | A hook reached through a symlinked folder still runs, a hook's state file is replaced whole, and a moment's lock on Windows does not lose the write. | Paths are compared as typed, so a hook reached through a symlinked folder never runs and allows everything. | CAUGHT |
|  |  | Every module counts as the script being run, so importing a hook runs it. | CAUGHT |
|  |  | A refused rename is not tried again, so a moment's lock on Windows loses the write. | CAUGHT |
|  |  | EPERM, the error Windows gives for a held file, is not treated as a moment's lock. | CAUGHT |
|  |  | Every error is tried again, so a full disk holds the hook up. | CAUGHT |
|  |  | A write that gives up leaves its temporary file behind. | CAUGHT |
|  |  | The number of tries changes, so a long lock waits longer or a short one is lost. | CAUGHT |
| `model-ladder` | Each subagent call must name a model, and the model has to fit the job: expensive models only for listed jobs, cheap ones never for reviews, and nothing above cheap for plain lookups. | The expensive-model job check is switched off, so any job can use the expensive tier. | CAUGHT |
|  |  | Build words no longer rescue a description from the lookup rule, so "find every caller and fix them" is refused. | CAUGHT |
|  |  | The end-of-word boundary is dropped, so "listen" counts as the lookup word "list". | CAUGHT |
|  |  | Lookup words count anywhere in the description again, so a noun such as "folder list" sends a build job to the cheap model. | CAUGHT |
|  |  | Read-only agent types are no longer excused, so a scout that names a review in passing is refused a cheap model. | CAUGHT |
| `secret-guard` | Commands that print credentials and writes that contain a credential are refused, and the refusal never repeats the credential. | PowerShell backslash paths reach the tokenizer as escapes, so gc .\.env goes unseen. | CAUGHT |
|  |  | The AWS key pattern asks for one character too many, so real keys no longer match. | CAUGHT |
|  |  | A bare printenv is no longer treated as a dump of every variable. | CAUGHT |
|  |  | The list of template env files forgets .template, so reading one is refused. | CAUGHT |
|  |  | The generic sk- key pattern drops its length floor, so short placeholders are refused. | CAUGHT |
|  |  | gh auth token is no longer recognised. | CAUGHT |
|  |  | The PowerShell tool is no longer checked, so Get-Content .env passes. | CAUGHT |
|  |  | Variable names match anywhere in the name, so echo $MONKEY is refused. | CAUGHT |
|  |  | The documented AWS example key is refused because the EXAMPLE suffix is not recognised. | CAUGHT |
|  |  | Single quotes are not tracked, so a variable name inside single quotes counts as an expansion. | CAUGHT |
|  |  | Only six file readers are checked, so grep, sed, awk and source can print an env file. | CAUGHT |
|  |  | The search pattern is treated as a file name, so grep .env README.md is refused. | CAUGHT |
|  |  | The Read tool is no longer checked, so an env file can be opened without a shell. | CAUGHT |
|  |  | A command that writes a credential into a file is not scanned. | CAUGHT |
|  |  | Printing the whole environment with env is allowed. | CAUGHT |
|  |  | The reason stops naming a safe way to list variable names. | CAUGHT |
| `shell` | The shell tokenizer keeps quoted text from looking like a command, reads the commands inside a double-quoted command substitution as commands of their own, and never mistakes an output redirection for an argument. | The target of an output redirection stays as a word, so > out.txt reads as an argument. | CAUGHT |
|  |  | The file descriptor stays as a word, so 2>&1 leaves a stray 2 among the arguments. | CAUGHT |
|  |  | The ampersand in 2>&1 ends the command, so a stray 1 reads as a command of its own. | CAUGHT |
|  |  | The ampersand in &> ends the command, so the words after the redirection become a new command. | CAUGHT |
|  |  | A dangling redirection swallows the first word of the next command, so git status loses its name. | CAUGHT |
|  |  | A command substitution inside double quotes is no longer scanned, so the quote ends at the first inner double quote and a heredoc body line becomes a command. | CAUGHT |
|  |  | Backticks inside double quotes are read as plain text, so a command inside them goes unseen. | CAUGHT |
|  |  | A closing parenthesis ends the substitution even when it closes a nested group, so the rest of the quoted text is misread. | CAUGHT |
|  |  | withoutInput keeps the file named after a separate <, so that file still reads as an argument. | CAUGHT |
| `step-budget` | An agent is warned once when it nears its tool-call limit, then refused everything except reading, and each agent is counted on its own. | The warning is skipped, so an agent reaches the hard limit without being told. | CAUGHT |
|  |  | Past the hard limit, editing and shell calls are no longer refused. | CAUGHT |
|  |  | Two agents in one session share a counter. | CAUGHT |
|  |  | Reading is refused past the limit, so the agent cannot look up what it needs for its hand-off. | CAUGHT |
|  |  | The warning repeats on every call after the first. | CAUGHT |

## Stop hooks

| Tool | What it guarantees | Bug we planted | Result |
| --- | --- | --- | --- |
| `decision-ledger` | Every question marked for the person is recorded, shown again until answered, and leaves the list only by their words or a stated reason. | A question with no recommendation is never sent back. | CAUGHT |
|  |  | The same open list is shown on every prompt. | CAUGHT |
|  |  | An answer with empty words is accepted. | CAUGHT |
|  |  | A question with no recommendation is recorded before it is sent back, so the retry leaves two decisions. | CAUGHT |
|  |  | The folder is created without a .gitignore, so git add . can commit the ledger. | CAUGHT |
|  |  | Old state files are never deleted. | CAUGHT |
|  |  | State files younger than 30 days are deleted too. | CAUGHT |
| `decisions-file` | A running session sees each change to the rulings file, as added and removed lines only, at its next prompt. | Removed lines are never shown. | CAUGHT |
|  |  | The first prompt of a session prints the whole file. | CAUGHT |
|  |  | Old snapshots are never deleted. | CAUGHT |
|  |  | The cleanup matches every file in the shared state folder, not only its own snapshots. | CAUGHT |
| `never-say` | A final message containing a listed line goes back once, naming the matched words, the reason and the replacement. | Every match is ignored, so nothing is ever sent back. | CAUGHT |
|  |  | Fenced code and quoted lines are matched too, so quoting a listed phrase is sent back. | CAUGHT |
| `proof-required` | A claim of completion after an edit needs a check command that ran after the last edit, or a plain statement that nothing was verified. | A check that ran before the last edit counts as proof. | CAUGHT |
|  |  | A message that admits the change was not verified is still sent back. | CAUGHT |

## Proof tools

| Tool | What it guarantees | Bug we planted | Result |
| --- | --- | --- | --- |
| `contract-check` | A contract line is reported PROVEN only when its test passes clean and fails once its planted fault is in place, and the exit code is 0 only when every line is PROVEN. | A line whose test still passes with the fault in place is reported as PROVEN. | CAUGHT |
|  |  | A line that was proven is reported as UNPROVEN. | CAUGHT |
|  |  | The exit code ignores MISSED lines and fails only on UNPROVEN ones. | CAUGHT |
|  |  | The --changed filter is ignored, so every contract is proved again. | CAUGHT |
|  |  | The timeout option is not passed on, so a hanging fault waits for the default limit. | CAUGHT |
| `find-vacuous-tests` | Every test that has no assertion, a check that always passes, a leftover .only or a skip with no reason is reported with its file and line, and a test that can fail is not. | A test body with no assertion is never reported. | CAUGHT |
|  |  | A test with no inline callback is inspected as if it had an empty body. | CAUGHT |
|  |  | A skipped test is never reported, even with no reason given. | CAUGHT |
|  |  | Two different literals are reported as the same literal on both sides. | CAUGHT |
|  |  | A test that calls a shared check helper is reported as having no assertion. | CAUGHT |
|  |  | Any helper function counts as asserting, even one whose body checks nothing. | CAUGHT |
| `pin-check` | Pinned wording must appear byte for byte (line endings aside) in its file, forbidden text must appear nowhere, and a missing pinned file is a finding. | Reworded text passes because the presence check never reports. | CAUGHT |
|  |  | Line endings are no longer converted, so a file saved with CRLF fails every multi-line pin. | CAUGHT |
|  |  | A missing pinned file is not reported. | CAUGHT |
| `plain-copy` | Phrases that read as machine-written are reported with file, line and a plain alternative, while code, noun uses and allowed words are left alone. | Every match is skipped as if its word were on the allow list. | CAUGHT |
|  |  | The noun use of leverage is reported along with the verb. | CAUGHT |
|  |  | Fenced code is scanned because the fence is closed as soon as it opens. | CAUGHT |
|  |  | Inline code spans are scanned like prose. | CAUGHT |
| `planted-fault` | A planted bug is reported CAUGHT only when the named test fails on it, and the file is always put back exactly as it was. | A test that still passes with the bug in place is reported as CAUGHT. | CAUGHT |
|  |  | A test that is already red before the bug is planted is still accepted. | CAUGHT |
|  |  | A find text that matches more than once is accepted. | CAUGHT |
|  |  | The file is left broken after the run. | CAUGHT |
|  |  | The test run has no time limit, so a fault that hangs the test hangs the tool. | CAUGHT |
|  |  | A run killed by a signal is reported as CAUGHT. | CAUGHT |
|  |  | The clean run gets the small limit too, so a slow machine reads as a setup problem. | CAUGHT |
| `proof-matrix` | Every planted fault of every tool is run in a throwaway copy of the repo, and any fault whose test still passes is reported as MISSED. | A fault whose test still passes is reported as CAUGHT. | CAUGHT |
|  |  | The first fault of every tool is dropped from the run. | CAUGHT |
|  |  | The planted bug is written into the working tree instead of the temp copy. | CAUGHT |
|  |  | The temp copy is left behind. | CAUGHT |
|  |  | A timed out fault is reported as CAUGHT. | CAUGHT |
|  |  | The timeout option is not passed on to the fault runs. | CAUGHT |
| `replay` | Runs past session transcripts through the stateless guards and reports how many calls each would have denied, counting each tool call once. | Denies are never counted, so the report always says the guards would have done nothing. | CAUGHT |
|  |  | A tool call id seen before is read again, so one call spread over several lines is counted twice. | CAUGHT |
|  |  | The shown command is printed without masking, so a credential reaches the terminal. | CAUGHT |

## Cost tools

| Tool | What it guarantees | Bug we planted | Result |
| --- | --- | --- | --- |
| `ci-minutes` | Totals Actions minutes for the month and reports OVER when the pace would pass the cap minus the reserve. | Job time rounds down, so the total is always short. | CAUGHT |
|  |  | The reserve is ignored when judging OVER. | CAUGHT |
|  |  | The WATCH line moves up to 95 percent of the cap. | CAUGHT |
|  |  | Runs still in progress are cached, so their later minutes are never counted. | CAUGHT |
|  |  | Windows and macOS minutes are counted at the Linux rate. | CAUGHT |
|  |  | Windows minutes are counted once, not twice. | CAUGHT |
|  |  | Reruns are missed, because only the latest attempt of each run is read. | CAUGHT |
|  |  | The whole month is one search, so a busy month hits the 1000-result cap. | CAUGHT |
|  |  | A private repository is reported as public. | CAUGHT |
| `usage-report` | Reports token use per transcript, counts each API response once, and flags sessions that pass the request or context limit. | Placeholder lines count as requests, so idle sessions look busier than they were. | CAUGHT |
|  |  | Only the request count is checked, so a session with a huge context is never flagged. | CAUGHT |
|  |  | Repeated lines of one response are counted as separate requests. | CAUGHT |
|  |  | Old files are no longer skipped by modification time. | CAUGHT |

## Coordination

| Tool | What it guarantees | Bug we planted | Result |
| --- | --- | --- | --- |
| `demo` | The demo exits 1 whenever a scene's result differs from what it expects, and removes its temp folder. | The git-guard deny scene tries an allowed command while still expecting a denial, so its expected result is wrong. | CAUGHT |
|  |  | Every scene counts as matching, whatever the hook did. | CAUGHT |
|  |  | The temp folder is left behind after the run. | CAUGHT |
| `gen-plugin-hooks` | Generates the plugin's hooks file from the hook table and fails its check when the two differ. | The generator leaves hooks out of the file, so the plugin ships without them. | CAUGHT |
|  |  | The check always passes, so a stale hooks file goes unnoticed. | CAUGHT |
|  |  | Hook commands use the project folder variable, so they point outside the installed plugin. | CAUGHT |
| `lane-board` | Lists the files each git worktree is changing and names every file that two or more lanes touch. | A squash-merged lane keeps counting as editing its files, so finished work reads as an overlap. | CAUGHT |
|  |  | Untracked files are left out, so a new file edited in two lanes goes unseen. | CAUGHT |
|  |  | A file needs three lanes before it counts as an overlap. | CAUGHT |
|  |  | Every changed file is reported as an overlap, even in one lane. | CAUGHT |
|  |  | A deleted worktree folder is read like a live one, so the whole board fails. | CAUGHT |
|  |  | Live worktrees are shown as missing. | CAUGHT |
| `setup` | Setup merges the hooks into a project's settings without losing anything already there, adds each only once, and refuses a damaged file untouched. | A hook already in place is added again on every run. | CAUGHT |
|  |  | Existing hooks in the project are replaced instead of kept. | CAUGHT |
|  |  | Other settings in the file are dropped. | CAUGHT |
|  |  | A file that is not valid JSON is overwritten as if it were empty. | CAUGHT |
|  |  | A dry run still writes the file. | CAUGHT |
|  |  | An unknown hook name given to --only is ignored instead of refused. | CAUGHT |

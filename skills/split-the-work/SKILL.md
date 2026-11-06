---
name: split-the-work
description: Cut a large task into briefs that agents can work on at once without touching the same files. Use before starting more than one agent on a task.
---

## Steps

1. List every file the task will change. Group them by the part of the work they belong to.
2. Cut along those groups. Each group becomes one brief. A file belongs to exactly one brief. If two groups need the same file, merge them, or make one wait for the other.
3. Give each agent its own worktree on its own branch:

```
git worktree add ../<repo>-<lane> -b lane/<lane>
```

4. Write each brief with these parts: the goal in one sentence, the files it owns, the files it may read, the command that proves it is done, and what to report. Name the model that fits the job: a cheap one for lookups, a mid one for builds, the top one for reviews.
5. Put the lanes in an owners file so the file-ownership hook refuses a stray edit. See `examples/owners.json`.
6. Check for overlap before starting and again before merging:

```
node bin/lane-board.mjs
node bin/lane-board.mjs --strict
```

The board lists the files each worktree is changing and names any file that two or more lanes touch. With `--strict` it exits 1 on an overlap.

7. Merge one lane at a time. Run the proof command after each merge.

## Rules of thumb

- Do the part everything else depends on first, and start the agents that depend on it after.
- A brief an agent cannot finish alone is two briefs.
- Keep shared files such as the README and the package file with one owner.

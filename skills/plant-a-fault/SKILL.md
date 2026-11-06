---
name: plant-a-fault
description: Write a fault file for a tool and check its test catches each bug. Use when adding a tool or when a test may be too weak.
---

A fault is a bug you plant on purpose. The tool's test must fail on it.

## The file

Save `proof/faults/<name>.json`:

```json
{
  "name": "<name>",
  "kind": "guard | stop-hook | proof-tool | cost-tool | coordination",
  "what": "One plain sentence: what the tool guarantees.",
  "faults": [
    {
      "fault": "One plain sentence: the bug planted.",
      "file": "hooks/<name>.mjs",
      "find": "exact source text that appears once in the file",
      "replace": "the broken version",
      "test": "node --test test/<name>.test.mjs"
    }
  ]
}
```

## Choosing faults

- Plant at least two, in opposite directions. One makes the tool let through what it must stop. The other makes it refuse what it must allow, or breaks a second guarantee.
- Plant them in the logic. A change to a comment or a message string proves nothing.
- `find` must match exactly once. The runner refuses a text that matches twice or not at all.

## Running

```
node bin/planted-fault.mjs --file hooks/<name>.mjs --find "<find>" --replace "<replace>" --test "node --test test/<name>.test.mjs"
```

CAUGHT means the test failed on the broken copy. MISSED means it passed, so strengthen the test and leave the fault alone. To run every fault in the file, use `node bin/proof-matrix.mjs --check --only <name>`.

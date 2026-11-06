---
name: write-a-contract
description: Write always and never lines for a feature, each tied to the test that proves it, and check them with contract-check. Use before building a feature or when its rules are unclear.
---

A contract says what a feature must always do and never do, in lines a test can fail.

## The file

Save `contracts/<feature>.json`:

```json
{
  "feature": "<feature>",
  "purpose": "One line: what the feature is for.",
  "always": [
    {
      "rule": "An outcome a test can fail.",
      "test": "node --test test/<feature>.test.mjs",
      "fault": { "file": "src/<feature>.mjs", "find": "exact text", "replace": "broken text" }
    }
  ],
  "never": []
}
```

## Writing the lines

- Write each line as an outcome you can observe, such as "an edit outside the lane is refused, naming the path". Avoid lines about how the code is built.
- Write them from what the person who asked for the feature said, before the code exists.
- Every line names its test and one planted fault. A line with no test, or a test that still passes on the fault, counts as unproven.
- Cover the never side. "A session with no lane is never restricted" catches a different bug than any always line.

## Checking

```
node bin/contract-check.mjs
node bin/contract-check.mjs --changed src/<feature>.mjs
```

The first checks every contract. The second checks only the contracts whose files you changed. A line shows PROVEN, MISSED or UNPROVEN, and only PROVEN counts.

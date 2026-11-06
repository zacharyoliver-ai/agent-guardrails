// The one place that says which event and tool matcher each hook belongs to.
// bin/setup.mjs and examples/settings.json are both made from it.
export const HOOKS = [
  { name: 'step-budget', on: [['PreToolUse', '*']] },
  { name: 'file-ownership', on: [['PreToolUse', 'Edit|Write|NotebookEdit']] },
  { name: 'design-seat', on: [['PreToolUse', 'Edit|Write|Bash']] },
  { name: 'git-guard', on: [['PreToolUse', 'Bash']] },
  { name: 'secret-guard', on: [['PreToolUse', 'Bash|Edit|Write|NotebookEdit']] },
  { name: 'bulk-write-gate', on: [['PreToolUse', 'Bash|mcp__.*']] },
  { name: 'foreground-wait', on: [['PreToolUse', 'Bash']] },
  { name: 'model-ladder', on: [['PreToolUse', 'Agent|Task']] },
  {
    name: 'fleet-cap',
    on: [
      ['PreToolUse', 'Agent|Task'],
      ['SubagentStop', ''],
    ],
  },
  { name: 'never-say', on: [['Stop', '']] },
  { name: 'proof-required', on: [['Stop', '']] },
  {
    name: 'decision-ledger',
    on: [
      ['Stop', ''],
      ['UserPromptSubmit', ''],
    ],
  },
  { name: 'decisions-file', on: [['UserPromptSubmit', '']] },
];

/** The hooks object for the named hooks. `dir` is the folder holding hooks/, written into each command. */
export function buildHooks(dir, names = HOOKS.map((h) => h.name)) {
  const out = {};
  for (const h of HOOKS.filter((x) => names.includes(x.name))) {
    for (const [event, matcher] of h.on) {
      const hooks = [{ type: 'command', command: `node "${dir}/hooks/${h.name}.mjs"` }];
      (out[event] ||= []).push(matcher ? { matcher, hooks } : { hooks });
    }
  }
  return out;
}

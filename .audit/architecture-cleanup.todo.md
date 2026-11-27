- [x] Read the Principles section of the poteto-mode skill
- [x] Frame: state the done predicate, quantify scope, and choose rigor
- [x] Design the workflow: baseline test run, parallel scan, one-unit-at-a-time refactor
- [x] Fan out: scan the app in parallel slices and collect findings
- [x] Aggregate: consolidate findings into a single ranked issue list
- [x] Unit 1: centralize every log-row render path on one shared renderer
- [x] Unit 2: group duplicated server HTML fragments and card builders
- [x] Unit 3: group duplicated client polling and fragment helpers
- [x] Unit 4: consolidate CSS duplicates and remove stale selectors
- [x] Unit 5: harden tests and docs against the grouped architecture
- [x] Keep the audit trail in .audit/architecture-cleanup.tsv
- [x] Verify the whole against the done predicate
- [x] Hand back with playbook, rigor, trail path, verified items, open items

Swarm phases
- [x] Frame: done predicate, shape, worker model, writable outputs
- [x] Fan out: independent scan workers with standalone briefs
- [x] Aggregate: read terminal results, drop or respawn incomplete ones
- [x] Report: consolidated table, one-liners, gaps (at handback)

Open items from handback
- [x] Fix the heartbeat boot-recovery flake at its root
- [x] Collapse the remaining duplicate `.setting-label`, `.setting-value`, and `.setting-key` rules
- [x] Run a real browser smoke check and capture screenshots
- [ ] Commit the verified work with a house-style message

# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sortretired-a11y/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sortretired-a11y/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One command-line tool that applies the edits AI models write, in all four formats they write them
in: unified diffs with line numbers that drifted, SEARCH/REPLACE blocks, V4A patches, and text-editor
tool calls as JSON. It finds the lines an edit names even when the model moved their whitespace or
indentation, and it changes every file or none. Written to the specification in
[`SPEC.md`](SPEC.md) that ships with the kit.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file; absent or `-` reads standard input.
- `--format=auto|unified|search-replace|v4a|json` (default `auto` detects the format).
- `--check` does everything but write.
- `--strict` matches lines exactly, tier 0 only.

```sh
printf 'f.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n' | node main.ts --check
```

Exit 0 writes the tree and prints one `A`/`D`/`M`/`R` line per changed path in UTF-8 byte order,
then `ok: <n> files`. Exit 1 prints `error: <code> <path>` per failed edit and `failed: <k> of <n>
edits`, and writes nothing. Exit 2 prints one line — `usage`, `no-patch`, `format` or `parse <N>` —
and writes nothing.

## How it works

`main.ts` is the whole tool, in Node 22 and its standard library alone.

- **Reading.** `detect` picks the format by the first rule that holds: a `*** Begin Patch` opener is
  V4A, a leading `[` or `{` is JSON, a `<<<<<<< SEARCH` line is SEARCH/REPLACE, a `diff --git` line or
  a `--- ` then `+++ ` pair is unified.
- **Matching.** `findTier` looks for the old lines at three tiers — exact, then ignoring trailing
  spaces and tabs, then ignoring leading and trailing both — and takes the first tier that matches at
  all. `--strict` stops at the first. At the indentation tier `emitN` re-indents the new lines by the
  shift between the file's own first matched line and the patch's, so moved code lands where the file
  holds it rather than where the model guessed.
- **Placement.** A unified hunk takes the occurrence nearest `A - 1 + d`, where `A` is the header's
  old-line number and `d` the drift from the hunks before it in the section. A V4A chunk walks a
  cursor forward, so `@@ <anchor>` is a breadcrumb: matching starts past the anchor and the edit lands
  on the next occurrence after it, not on the first in the file.
- **Writing.** `Tree` keeps the original bytes and the pending state per path, so an edit sees what
  the edits before it did. A failed edit rolls its own path back and the rest still run; when any edit
  failed nothing is written at all.
- **Moves.** A move copies the result to the new path and drops the old, and the summary prints one
  `R <old> -> <new>` line in place of that pair's `D` and `A`.

`runner.ts` and `check.ts` are the kit's, kept as handed out. `runner.ts` is what the grader runs:
with `MAKEFUN_ENV_URL` set, `main.ts` hands over to it, it reads the trial's checks, runs this CLI on
each one in a fresh directory, and posts the exit code, stdout and files back.

## Checking it

`check.ts` runs all 100 public practice checks against the implementation:

```sh
node check.ts <kit>/program/generator/practice.json
```

100 of 100 pass, and the same 100 of 100 on all three practice instances when driven through the
kit's own env server and scorer, which is the path the grader takes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=twqewgbj&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

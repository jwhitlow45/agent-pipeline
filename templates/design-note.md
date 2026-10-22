# <Project>: <feature>

Status: draft 1. Code is cited from main at `<commit>`.

The owner, <date>: "<the user's words, verbatim>"

<!-- About 400 lines before the appendix. Measurements and worked examples go in the appendix. -->

## 0. Today and the answer in short

**Today.** What the code does now, with file and line references.

**The answer.** Five or six bullets: where it lives, the data, the rules, safety, versions.

## 1. Where it lives and the flow

Surfaces, steps, and every state the data can be in when the feature meets it.

## 2. Rules

The behavior, rule by rule, precise enough to test.

## 3. UI and UX

<!-- Required when the change has UI. -->

Entry point, each screen and its states, every error, loading states, keys and focus, screen readers, small screens and large interface sizes, the exact words.

## 4. Data, protocol and versions

Fields, bounds, migrations, replay of older stored data, permissions and who may see what.

## 5. Edge-case matrix

| Case | Expected | Test |
|---|---|---|

## 6. Tests

Unit table, randomized state-machine test and its invariants, integration and e2e steps, mutation checks.

## 7. Build plan

One line per commit, conventional, with the files each touches. Name files shared with lanes in flight.

## 8. Decided, for the owner to overrule

Numbered. Each: the choice, then "Rejected:" with the alternatives and why.

## 9. As built

Filled in by the build: where it chose what the note left open.

## Appendix A. Measurements

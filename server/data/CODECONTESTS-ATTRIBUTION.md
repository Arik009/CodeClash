# CodeContests attribution

`codecontests.json.gz` holds 120 problems taken from the
[DeepMind CodeContests dataset](https://github.com/google-deepmind/code_contests),
published under the [Creative Commons Attribution 4.0 licence](https://creativecommons.org/licenses/by/4.0/).
The problems themselves first appeared on [Codeforces](https://codeforces.com); every
problem keeps its Codeforces contest id, index and URL in its `source` field, and the
problem page shows that source to participants.

Li, Y., Choi, D., Chung, J., et al. *Competition-level code generation with AlphaCode*.
Science 378, 1092–1097 (2022).

## What we changed

- Statements: the Examples section is removed (samples are shown separately), LaTeX
  markers (`$$$`) become inline code, and blank lines are collapsed.
- Tests: at most 15 per problem and 96 KB in total, taken from the public, private and
  generated tests of the dataset, without duplicates.
- Limits: time limits are clamped to 1–4 seconds and memory to 64–512 MB.
- Input specs are drafted automatically where the statement allowed it.

## How problems were chosen

`scripts/import-codecontests.mjs` keeps a problem only if it is a Codeforces problem with
a rating of at most 2400, standard input and output, no images, no interaction, a single
correct answer per test, and a statement under 6000 characters. Two of the dataset's
correct solutions must produce identical output on every kept test in our sandbox, and
each kept incorrect solution must fail at least one of them.

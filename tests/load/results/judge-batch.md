# Judge batch: before and after

12 tests of growing size (50 to 4450 numbers), median of 2 rounds, all verdicts AC.
Before: a fresh container (and compile) for every test. After: `JUDGE_BATCH=1`, one compile and one container for all tests.

| language | before ms | after ms | speedup |
| --- | --- | --- | --- |
| python | 9625 | 1638 | 5.88x |
| cpp | 32755 | 3108 | 10.54x |
| java | 28940 | 4294 | 6.74x |

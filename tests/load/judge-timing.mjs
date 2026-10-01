// Compares stopping at the first failure with judging every case.
// Each case stands in for one container start.

const cases = 8;
const caseMs = 25;

async function judge(stopEarly) {
  const started = performance.now();
  let ran = 0;
  for (let i = 0; i < cases; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, caseMs));
    ran += 1;
    if (stopEarly) break;
  }
  return { ran, ms: Math.round(performance.now() - started) };
}

const early = await judge(true);
const all = await judge(false);
console.log(JSON.stringify({ earlyExit: early, everyCase: all, savedMs: all.ms - early.ms }, null, 2));

import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { percentile, runCapacity, validateProfile } from '../scripts/capacity/open-arrival.mjs';

const execFile = promisify(execFileCallback);
const runnerPath = fileURLToPath(new URL('../scripts/capacity/open-arrival.mjs', import.meta.url));
const schema = JSON.parse(await readFile(new URL('../docs/capacity/v1/result.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateResult = ajv.compile(schema);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function profile(overrides = {}) {
  const base = {
    schemaVersion: 1,
    name: 'capacity-runner-test',
    target: 'https://capacity.example.invalid',
    expectedPeak: { arrivalsPerSecond: 100, liveConnections: 20, messagesPerSecond: 100 },
    release: {
      appRevision: 'git:test-app',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      worktree: 'clean',
      packages: {
        'svelte-adapter-uws': 'git:test-adapter',
        'svelte-realtime': 'git:test-realtime',
        'svelte-adapter-uws-extensions': 'git:test-extensions'
      }
    },
    environment: {
      location: 'test-generator',
      hostClass: 'test-host',
      osImage: 'test-image',
      powerProfile: 'fixed',
      networkPath: 'test -> target'
    },
    topology: {
      regions: ['test-region'],
      instancesPerRegion: 1,
      workersPerInstance: 1,
      cpuPerInstance: 1,
      memoryMiBPerInstance: 128,
      loadBalancer: 'test-balancer',
      dataStores: ['test-store'],
      autoscaling: { minInstances: 1, maxInstances: 2, signal: 'test.metric', target: 0.7, cooldownSeconds: 0 }
    },
    phases: [
      { name: 'warmup', durationMs: 80, arrivalRate: 100 },
      { name: 'expected_peak', durationMs: 80, arrivalRate: 100 },
      { name: 'overload', durationMs: 80, arrivalRate: 200 },
      { name: 'recovery', durationMs: 80, arrivalRate: 100 }
    ],
    scenarios: [{
      name: 'round-trip',
      weight: 1,
      description: 'delayed application acknowledgement',
      async run({ signal }) {
        await delay(25, signal);
        return { ok: true, status: 200, bytesIn: 10, bytesOut: 5 };
      }
    }],
    slo: {
      // Headroom over the 25 ms service delay, because latency now includes
      // the wait for a launch slot: with 8 attempts per phase the p95 IS the
      // max, so one scheduling hiccup on a loaded machine would otherwise
      // fail an assertion about something else entirely.
      p95MsMax: 400,
      p99MsMax: 400,
      errorRateMax: 0,
      recoveryP95MsMax: 100,
      recoveryErrorRateMax: 0,
      recoveryWindowMs: 40,
      recoveryWithinMs: 80
    },
    generator: {
      maxInFlight: 100,
      operationTimeoutMs: 200,
      sampleIntervalMs: 5,
      drainTimeoutMs: 200,
      // Explicit rather than derived, and legal because the latency bound
      // above is 400: the derived budget would be 100 ms, which is a real
      // tolerance change for a suite whose runs are a few hundred
      // milliseconds long on a machine with coarse timers.
      maxSchedulerLagMs: 200
    },
    saturation: [{ resource: 'event loop', metric: 'runtime.lag', operator: 'gte', threshold: 0.7, unit: 'ratio' }],
    sample({ phase }) {
      return { runtime: { lag: phase === 'overload' ? 0.8 : 0.1 } };
    }
  };
  return { ...base, ...overrides };
}

describe('capacity kit', () => {
  // The primary open-model saturation signal is completion throughput falling
  // below offered load. It can only ever appear if the two are measured
  // differently - computing both from the same set makes the artifact
  // structurally incapable of reporting saturation.
  it('credits a phase only with the work that finished inside it', async () => {
    const candidate = profile();
    // Every operation outlives the 80 ms phase that launched it, so each phase
    // starts its full offered load and completes none of it.
    candidate.scenarios[0].run = async ({ signal }) => {
      await delay(120, signal);
      return { ok: true, status: 200 };
    };
    const result = await runCapacity(candidate);
    const peak = result.phases.find((phase) => phase.name === 'expected_peak');

    expect(peak.started).toBeGreaterThan(0);
    expect(peak.completed).toBe(0);
    expect(peak.completionRate).toBe(0);
    expect(peak.completionRate).toBeLessThan(peak.achievedStartRate);
  });

  // Latency measured from the actual start hides the time an arrival waited
  // for a launch slot - the delay a real client feels when the generator
  // itself is the bottleneck, and the coordinated omission this kit refuses.
  it('anchors latency to the scheduled arrival and publishes the decomposition', async () => {
    const candidate = profile();
    // Block the loop on the first arrival of the peak phase, so the arrivals
    // scheduled behind it provably start late. Their service time is
    // unaffected - only the wait for a launch slot grows - so a
    // start-anchored measurement would report this run as fast while real
    // clients waited. Busy work rather than a timer, because a timer would
    // yield and let the injector keep up.
    let stalled = false;
    candidate.scenarios[0].run = async ({ phase, signal }) => {
      if (phase === 'expected_peak' && !stalled) {
        stalled = true;
        const until = Date.now() + 60;
        while (Date.now() < until) { /* hold the loop */ }
      }
      await delay(5, signal);
      return { ok: true, status: 200 };
    };
    const result = await runCapacity(candidate);
    const peak = result.phases.find((phase) => phase.name === 'expected_peak');

    // The artifact says what its latency was measured from, so a result
    // produced by the earlier start-anchored generator cannot be mistaken for
    // one of these - it lacks the field and fails schema conformance.
    expect(result.latencyAnchor).toBe('scheduled-arrival');
    for (const family of ['latencyMs', 'serviceLatencyMs', 'queueDelayMs']) {
      expect(peak[family], family).toEqual(expect.objectContaining({ p50: expect.any(Number) }));
    }
    // The arrivals behind the stall started tens of milliseconds late. A
    // start-anchored measurement reports none of it; this one must, and must
    // attribute it to the generator rather than to the target - whose own
    // service time for those arrivals was the 5 ms delay.
    expect(peak.queueDelayMs.max).toBeGreaterThan(20);
    // Per attempt total = queue + service, so the total distribution can never
    // sit below the service one. Equality here would mean the queueing was
    // measured and then discarded.
    expect(peak.latencyMs.max).toBeGreaterThanOrEqual(peak.serviceLatencyMs.max);
    expect(peak.latencyMs.p95).toBeGreaterThan(peak.serviceLatencyMs.p95);
    expect(peak.queueDelayMs.p50).toBeGreaterThanOrEqual(0);
  });

  it('refuses a lag budget looser than the tightest latency SLO, and derives one when unset', () => {
    const loose = profile();
    loose.generator = { ...loose.generator, maxSchedulerLagMs: loose.slo.p95MsMax + 1 };
    expect(() => validateProfile(loose)).toThrow(/maxSchedulerLagMs.*must be <=/);

    // Omitted, the budget follows the SLO rather than a constant a tight
    // profile would trip over. The SLO here is tighter than the constant, so
    // this can only pass if the derivation actually ran.
    const derived = profile();
    derived.slo = { ...derived.slo, p95MsMax: 40, p99MsMax: 60 };
    delete derived.generator.maxSchedulerLagMs;
    expect(validateProfile(derived).generator.maxSchedulerLagMs).toBe(40);

    // And it never LOOSENS: a profile whose SLO is slacker than the constant
    // keeps the constant rather than inheriting a budget from the SLO.
    const slack = profile();
    slack.slo = { ...slack.slo, p95MsMax: 5_000, p99MsMax: 5_000 };
    delete slack.generator.maxSchedulerLagMs;
    expect(validateProfile(slack).generator.maxSchedulerLagMs).toBe(100);
  });

  // A window that carried almost none of the offered load is not evidence of
  // recovery; a sparse window is itself a symptom of a target still degraded.
  it('will not certify recovery from a window that carried almost no load', async () => {
    const candidate = profile();
    // Windows of 40 ms at 100/s expect four arrivals each; demanding all of
    // them makes a window that lost its arrivals unable to certify.
    candidate.slo = { ...candidate.slo, recoveryWindowMs: 40, recoveryWithinMs: 80, recoveryMinAttemptRatio: 1 };
    // Hold the loop through the first recovery window so the arrivals due
    // inside it cannot start until the second one. Window one is then left
    // with a single attempt that answers well within the recovery SLO - the
    // exact shape that used to certify recovery on its own.
    let stalled = false;
    candidate.scenarios[0].run = async ({ phase, signal }) => {
      if (phase === 'recovery' && !stalled) {
        stalled = true;
        const until = Date.now() + 45;
        while (Date.now() < until) { /* hold the loop */ }
      }
      await delay(2, signal);
      return { ok: true, status: 200 };
    };
    const result = await runCapacity(candidate);

    expect(result.recovery.minAttempts).toBe(4);
    // Recovery is certified by the SECOND window. Certifying at 40 ms would
    // mean the first window's lone attempt was accepted as evidence.
    expect(result.recovery.recovered).toBe(true);
    expect(result.recovery.recoveredAtMs).toBe(80);
    expect(result.recovery.attempts).toBeGreaterThanOrEqual(4);
  });

  it('rejects an unpinned or incomplete launch worksheet', () => {
    const candidate = profile();
    candidate.release.imageDigest = 'candidate:latest';
    candidate.topology.autoscaling = null;
    expect(() => validateProfile(candidate)).toThrow(/imageDigest.*sha256/);
    expect(() => validateProfile(candidate)).toThrow(/topology\.autoscaling is required/);
  });

  it('uses an open arrival clock and records peak, mix, saturation, and recovery evidence', async () => {
    let active = 0;
    let maximumActive = 0;
    const arrivals = new Set();
    const candidate = profile();
    candidate.scenarios[0].run = async ({ arrivalIndex, signal }) => {
      arrivals.add(arrivalIndex);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await delay(25, signal);
        return { ok: true, status: 200 };
      } finally {
        active -= 1;
      }
    };

    const result = await runCapacity(candidate);

    expect(maximumActive).toBeGreaterThan(1);
    expect(arrivals.size).toBe(40);
    expect(result.phases.map((phase) => phase.name)).toEqual(['warmup', 'expected_peak', 'overload', 'recovery']);
    expect(result.phases[1]).toMatchObject({ scheduled: 8, started: 8, failed: 0, injectorDropped: 0 });
    expect(result.phases[1].scenarios[0]).toMatchObject({ name: 'round-trip', scheduled: 8, started: 8, failed: 0 });
    expect(result.phases[1].latencyMs.p50).toBeGreaterThanOrEqual(20);
    expect(result.firstSaturatedResource).toMatchObject({ phase: 'overload', resource: 'event loop', offeredArrivalRate: 200 });
    expect(result.recovery).toMatchObject({ recovered: true, recoveredAtMs: 40 });
    expect(result.integrity).toMatchObject({ injectorDropped: 0, drainTimedOut: false, sampleErrors: 0 });
    expect(result.gates).toHaveLength(6);
    expect(result.pass).toBe(true);
    expect(validateResult(result), ajv.errorsText(validateResult.errors, { separator: '; ' })).toBe(true);
    const mutated = structuredClone(result);
    mutated.firstSaturatedResource.phase = 'warmup';
    expect(validateResult(mutated)).toBe(false);
  });

  it('does not accept a warmup-only threshold crossing as overload saturation', async () => {
    const candidate = profile();
    candidate.sample = ({ phase }) => ({ runtime: { lag: phase === 'warmup' ? 0.8 : 0.1 } });

    const result = await runCapacity(candidate);
    const saturationGate = result.gates.find((gate) => gate.name === 'overload_saturation_witness');

    expect(result.firstSaturatedResource).toBeNull();
    expect(saturationGate).toMatchObject({ pass: false, actual: null });
    expect(result.pass).toBe(false);
  });

  it('anchors telemetry ticks to the run clock instead of sample completion', async () => {
    const candidate = profile({
      generator: {
        maxInFlight: 100,
        operationTimeoutMs: 200,
        sampleIntervalMs: 20,
        drainTimeoutMs: 200
      }
    });
    candidate.sample = async ({ phase, signal }) => {
      await delay(15, signal);
      return { runtime: { lag: phase === 'overload' ? 0.8 : 0.1 } };
    };

    const result = await runCapacity(candidate);

    expect(result.integrity.telemetryTicks).toMatchObject({ expected: 16, started: 16, missed: 0 });
    expect(result.telemetry.samples).toHaveLength(16);
  });

  it('fails integrity when slow sampling misses absolute telemetry ticks', async () => {
    const candidate = profile({
      generator: {
        maxInFlight: 100,
        operationTimeoutMs: 200,
        sampleIntervalMs: 10,
        drainTimeoutMs: 200,
        maxSchedulerLagMs: 5
      }
    });
    candidate.sample = async ({ phase, signal }) => {
      await delay(30, signal);
      return { runtime: { lag: phase === 'overload' ? 0.8 : 0.1 } };
    };

    const result = await runCapacity(candidate);
    const integrityGate = result.gates.find((gate) => gate.name === 'injector_integrity');

    expect(result.integrity.telemetryTicks.expected).toBe(32);
    expect(result.integrity.telemetryTicks.missed).toBeGreaterThan(0);
    expect(result.integrity.telemetryTicks.started).toBeLessThan(result.integrity.telemetryTicks.expected);
    expect(integrityGate.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('fails injector integrity instead of reporting a false service pass', async () => {
    const candidate = profile({
      generator: {
        maxInFlight: 1,
        operationTimeoutMs: 200,
        sampleIntervalMs: 5,
        drainTimeoutMs: 200
      }
    });
    candidate.scenarios[0].run = async ({ signal }) => {
      await delay(50, signal);
      return { ok: true };
    };

    const result = await runCapacity(candidate);
    const integrityGate = result.gates.find((gate) => gate.name === 'injector_integrity');

    expect(result.integrity.injectorDropped).toBeGreaterThan(0);
    expect(integrityGate.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('refuses an existing output before importing the workload profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capacity-output-'));
    const outputPath = join(directory, 'existing.json');
    const markerPath = join(directory, 'profile-imported');
    const profilePath = join(directory, 'profile.mjs');
    await writeFile(outputPath, 'immutable-existing-bytes', 'utf8');
    await writeFile(profilePath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\nexport default {};\n`, 'utf8');

    try {
      let failure;
      try {
        await execFile(process.execPath, [runnerPath, '--profile', profilePath, '--output', outputPath]);
      } catch (error) {
        failure = error;
      }
      expect(failure?.code).toBe(2);
      expect(await readFile(outputPath, 'utf8')).toBe('immutable-existing-bytes');
      await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses nearest-rank percentiles with deterministic edge behavior', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });

  it('keeps shipped capacity artifacts free of executable control bytes', async () => {
    const artifacts = [
      new URL('../docs/capacity/v1/README.md', import.meta.url),
      new URL('../docs/capacity/v1/result.schema.json', import.meta.url),
      new URL('../scripts/capacity/open-arrival.mjs', import.meta.url)
    ];
    for (const artifact of artifacts) {
      const source = await readFile(artifact, 'utf8');
      expect(source).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    }
  });
});

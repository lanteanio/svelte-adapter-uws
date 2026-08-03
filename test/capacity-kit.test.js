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
      p95MsMax: 100,
      p99MsMax: 100,
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
        drainTimeoutMs: 200,
        maxSchedulerLagMs: 200
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
        drainTimeoutMs: 200,
        maxSchedulerLagMs: 200
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

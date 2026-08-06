#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const PHASES = ['warmup', 'expected_peak', 'overload', 'recovery'];
const DEFAULT_GENERATOR = Object.freeze({
  maxInFlight: 10_000,
  operationTimeoutMs: 30_000,
  sampleIntervalMs: 1_000,
  drainTimeoutMs: 60_000,
  maxSchedulerLagMs: 100
});
// Half the offered arrivals, so a window certifying recovery has to have
// carried a representative share of the load rather than one lucky operation.
const DEFAULT_RECOVERY_MIN_ATTEMPT_RATIO = 0.5;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function dataClone(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new TypeError(`${label} must contain JSON-safe data: ${error.message}`);
  }
}

function numericMetrics(value, label = 'sample metrics') {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isObject(entry)) copy[key] = numericMetrics(entry, `${label}.${key}`);
    else if (finite(entry)) copy[key] = entry;
    else throw new TypeError(`${label}.${key} must be a finite number or nested object`);
  }
  return copy;
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

/** Validate and normalize a capacity profile without contacting its target. */
export function validateProfile(input) {
  const errors = [];
  add(errors, isObject(input), 'profile must be an object');
  if (!isObject(input)) throw new TypeError(errors.join('\n'));

  add(errors, input.schemaVersion === 1, 'schemaVersion must be 1');
  add(errors, nonEmpty(input.name), 'name is required');
  add(errors, nonEmpty(input.target), 'target is required');

  const peak = input.expectedPeak;
  add(errors, isObject(peak), 'expectedPeak is required');
  if (isObject(peak)) {
    add(errors, positive(peak.arrivalsPerSecond), 'expectedPeak.arrivalsPerSecond must be > 0');
    add(errors, nonNegative(peak.liveConnections), 'expectedPeak.liveConnections must be >= 0');
    add(errors, nonNegative(peak.messagesPerSecond), 'expectedPeak.messagesPerSecond must be >= 0');
  }

  const release = input.release;
  add(errors, isObject(release), 'release is required');
  if (isObject(release)) {
    add(errors, nonEmpty(release.appRevision), 'release.appRevision is required');
    add(errors, /^sha256:[0-9a-f]{64}$/i.test(release.imageDigest ?? ''), 'release.imageDigest must be an immutable sha256 digest');
    add(errors, nonEmpty(release.worktree), 'release.worktree must identify clean/dirty patch state');
    add(errors, isObject(release.packages), 'release.packages is required');
    for (const name of ['svelte-adapter-uws', 'svelte-realtime', 'svelte-adapter-uws-extensions']) {
      add(errors, nonEmpty(release.packages?.[name]), `release.packages.${name} is required`);
    }
  }

  const environment = input.environment;
  add(errors, isObject(environment), 'environment is required');
  for (const key of ['location', 'hostClass', 'osImage', 'powerProfile', 'networkPath']) {
    add(errors, nonEmpty(environment?.[key]), `environment.${key} is required`);
  }

  const topology = input.topology;
  add(errors, isObject(topology), 'topology is required');
  if (isObject(topology)) {
    add(errors, Array.isArray(topology.regions) && topology.regions.length > 0 && topology.regions.every(nonEmpty), 'topology.regions must be non-empty');
    add(errors, positive(topology.instancesPerRegion), 'topology.instancesPerRegion must be > 0');
    add(errors, positive(topology.workersPerInstance), 'topology.workersPerInstance must be > 0');
    add(errors, positive(topology.cpuPerInstance), 'topology.cpuPerInstance must be > 0');
    add(errors, positive(topology.memoryMiBPerInstance), 'topology.memoryMiBPerInstance must be > 0');
    add(errors, nonEmpty(topology.loadBalancer), 'topology.loadBalancer is required');
    add(errors, Array.isArray(topology.dataStores) && topology.dataStores.length > 0 && topology.dataStores.every(nonEmpty), 'topology.dataStores must be non-empty');
    add(errors, isObject(topology.autoscaling), 'topology.autoscaling is required');
    if (isObject(topology.autoscaling)) {
      add(errors, positive(topology.autoscaling.minInstances), 'topology.autoscaling.minInstances must be > 0');
      add(errors, positive(topology.autoscaling.maxInstances), 'topology.autoscaling.maxInstances must be > 0');
      add(errors, topology.autoscaling.maxInstances >= topology.autoscaling.minInstances, 'topology.autoscaling.maxInstances must be >= minInstances');
      add(errors, nonEmpty(topology.autoscaling.signal), 'topology.autoscaling.signal is required');
      add(errors, positive(topology.autoscaling.target), 'topology.autoscaling.target must be > 0');
      add(errors, nonNegative(topology.autoscaling.cooldownSeconds), 'topology.autoscaling.cooldownSeconds must be >= 0');
    }
  }

  add(errors, Array.isArray(input.phases) && input.phases.length === PHASES.length, `phases must contain ${PHASES.join(', ')} in order`);
  if (Array.isArray(input.phases)) {
    input.phases.forEach((phase, index) => {
      add(errors, isObject(phase), `phases[${index}] must be an object`);
      add(errors, phase?.name === PHASES[index], `phases[${index}].name must be ${PHASES[index]}`);
      add(errors, positive(phase?.durationMs), `phases[${index}].durationMs must be > 0`);
      add(errors, nonNegative(phase?.arrivalRate), `phases[${index}].arrivalRate must be >= 0`);
      add(errors, Math.floor((phase?.durationMs ?? 0) * (phase?.arrivalRate ?? 0) / 1_000) >= 1, `phases[${index}] must schedule at least one arrival`);
    });
    add(errors, input.phases[1]?.arrivalRate === peak?.arrivalsPerSecond, 'expected_peak arrivalRate must equal expectedPeak.arrivalsPerSecond');
    add(errors, input.phases[2]?.arrivalRate > peak?.arrivalsPerSecond, 'overload arrivalRate must exceed expected peak');
  }

  add(errors, Array.isArray(input.scenarios) && input.scenarios.length > 0, 'scenarios must be non-empty');
  if (Array.isArray(input.scenarios)) {
    const names = new Set();
    for (const [index, scenario] of input.scenarios.entries()) {
      add(errors, nonEmpty(scenario?.name), `scenarios[${index}].name is required`);
      add(errors, !names.has(scenario?.name), `scenario name ${scenario?.name} is duplicated`);
      names.add(scenario?.name);
      add(errors, positive(scenario?.weight), `scenarios[${index}].weight must be > 0`);
      add(errors, nonEmpty(scenario?.description), `scenarios[${index}].description is required`);
      add(errors, typeof scenario?.run === 'function', `scenarios[${index}].run must be a function`);
    }
  }

  const slo = input.slo;
  add(errors, isObject(slo), 'slo is required');
  for (const key of ['p95MsMax', 'p99MsMax', 'recoveryP95MsMax', 'recoveryWithinMs', 'recoveryWindowMs']) {
    add(errors, positive(slo?.[key]), `slo.${key} must be > 0`);
  }
  for (const key of ['errorRateMax', 'recoveryErrorRateMax']) {
    add(errors, nonNegative(slo?.[key]) && slo?.[key] <= 1, `slo.${key} must be between 0 and 1`);
  }
  add(errors, (slo?.recoveryWindowMs ?? Infinity) <= (slo?.recoveryWithinMs ?? 0), 'slo.recoveryWindowMs must be <= recoveryWithinMs');
  add(errors, (slo?.recoveryWithinMs ?? Infinity) <= (input.phases?.[3]?.durationMs ?? 0), 'slo.recoveryWithinMs must fit inside the recovery phase');
  // How much of the recovery phase's offered load a window must actually have
  // carried before it may certify recovery. Optional with a default, because
  // every existing profile predates it and the default is the safe reading.
  //
  // Resolved into a LOCAL, never written back onto the caller's object: a
  // profile is an operator's evidence config, and an author who froze it (the
  // idiom this file itself uses for its defaults) would otherwise crash inside
  // the validator, while a misshaped `slo` would throw a raw engine error
  // before the aggregated report is assembled.
  const recoveryMinAttemptRatio = isObject(slo) && slo.recoveryMinAttemptRatio !== undefined
    ? slo.recoveryMinAttemptRatio
    : DEFAULT_RECOVERY_MIN_ATTEMPT_RATIO;
  if (isObject(slo)) {
    add(errors, positive(recoveryMinAttemptRatio) && recoveryMinAttemptRatio <= 1, 'slo.recoveryMinAttemptRatio must be > 0 and <= 1');
  }

  add(errors, typeof input.sample === 'function', 'sample must be a function');
  add(errors, Array.isArray(input.saturation) && input.saturation.length > 0, 'saturation thresholds must be non-empty');
  if (Array.isArray(input.saturation)) {
    for (const [index, threshold] of input.saturation.entries()) {
      add(errors, nonEmpty(threshold?.resource), `saturation[${index}].resource is required`);
      add(errors, nonEmpty(threshold?.metric), `saturation[${index}].metric is required`);
      add(errors, ['gte', 'lte'].includes(threshold?.operator), `saturation[${index}].operator must be gte or lte`);
      add(errors, finite(threshold?.threshold), `saturation[${index}].threshold must be finite`);
      add(errors, nonEmpty(threshold?.unit), `saturation[${index}].unit is required`);
      add(errors, threshold?.phases === undefined, `saturation[${index}].phases is not supported; launch saturation is overload-only`);
    }
  }

  const generator = { ...DEFAULT_GENERATOR, ...(input.generator ?? {}) };
  // A lag budget looser than the tightest latency SLO is not a budget: it
  // permits the generator to be later than the entire latency target while
  // still reporting integrity. Reported latency is anchored to the scheduled
  // arrival, so that lag lands inside the p95/p99 gates either way - this
  // keeps the integrity signal from calling such a run clean.
  //
  // Unset, the budget is DERIVED from the SLO rather than left at a constant
  // that a tight profile would trip over: a profile that never mentions the
  // generator is always coherent. Set explicitly and looser, it is a
  // deliberate misconfiguration and fails.
  const tightestLatencySlo = positive(slo?.p95MsMax) && positive(slo?.p99MsMax)
    ? Math.min(slo.p95MsMax, slo.p99MsMax)
    : null;
  if (input.generator?.maxSchedulerLagMs === undefined && tightestLatencySlo !== null) {
    generator.maxSchedulerLagMs = Math.min(DEFAULT_GENERATOR.maxSchedulerLagMs, tightestLatencySlo);
  } else if (tightestLatencySlo !== null) {
    add(
      errors,
      !positive(generator.maxSchedulerLagMs) || generator.maxSchedulerLagMs <= tightestLatencySlo,
      `generator.maxSchedulerLagMs (${generator.maxSchedulerLagMs}) must be <= the tightest slo latency bound (${tightestLatencySlo} ms); omit it to derive one`
    );
  }
  for (const key of ['maxInFlight', 'operationTimeoutMs', 'sampleIntervalMs', 'drainTimeoutMs', 'maxSchedulerLagMs']) {
    add(errors, positive(generator[key]), `generator.${key} must be > 0`);
  }
  if (Array.isArray(input.phases)) {
    for (const phase of input.phases) {
      add(errors, (phase?.durationMs ?? 0) >= generator.sampleIntervalMs * 2, `${phase?.name ?? 'phase'} durationMs must cover at least two telemetry intervals`);
    }
  }

  if (errors.length > 0) throw new TypeError(`Invalid capacity profile:\n- ${errors.join('\n- ')}`);

  for (const [label, value] of [['release', release], ['environment', environment], ['topology', topology], ['expectedPeak', peak], ['slo', slo], ['generator', generator], ['phases', input.phases], ['saturation', input.saturation]]) {
    dataClone(value, label);
  }
  // Normalized copies, so the resolved defaults travel with the profile the
  // run uses without the caller's own object ever being written to.
  return { ...input, generator, slo: { ...slo, recoveryMinAttemptRatio } };
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

/** The distribution shape every latency family in the artifact reports. */
function percentiles(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? null : Math.max(...values)
  };
}

function chooseScenario(scenarios, index) {
  const total = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  let ticket = ((index * 0.6180339887498949) % 1) * total;
  for (const scenario of scenarios) {
    ticket -= scenario.weight;
    if (ticket < 0) return scenario;
  }
  return scenarios.at(-1);
}

function metricAt(metrics, dottedPath) {
  let value = metrics;
  for (const part of dottedPath.split('.')) value = value?.[part];
  return value;
}

function crossed(value, threshold) {
  if (!finite(value)) return false;
  return threshold.operator === 'gte' ? value >= threshold.threshold : value <= threshold.threshold;
}

function summarizePhase(record, attempts, scenarios) {
  const own = attempts.filter((attempt) => attempt.phase === record.name);
  // Attempts are attributed to the phase that LAUNCHED them and recorded
  // whenever they finish, so a phase whose work drains into the next one must
  // not count that work as its own throughput. Completion falling below
  // offered load is the primary open-model saturation signal, and it can only
  // appear if these two are measured differently.
  const finishedInPhase = own.filter((attempt) => attempt.completedAtMs < record.endedAtMs);
  const latencies = own.map((attempt) => attempt.latencyMs);
  const failed = own.filter((attempt) => !attempt.ok).length;
  const seconds = record.durationMs / 1_000;
  return {
    name: record.name,
    targetArrivalRate: record.arrivalRate,
    durationMs: record.durationMs,
    scheduled: record.scheduled,
    started: own.length,
    completed: finishedInPhase.length,
    succeeded: own.length - failed,
    failed,
    injectorDropped: record.injectorDropped,
    achievedStartRate: own.length / seconds,
    completionRate: finishedInPhase.length / seconds,
    errorRate: own.length === 0 ? 1 : failed / own.length,
    // `latencyMs` is what a client at this offered rate would have observed:
    // scheduled arrival to completion. The SLO gates read it. The two
    // components below decompose it - `serviceLatencyMs` is the target's own
    // time, `queueDelayMs` is how late the injector was to start.
    serviceLatencyMs: percentiles(own.map((attempt) => attempt.serviceLatencyMs)),
    queueDelayMs: percentiles(own.map((attempt) => attempt.queueDelayMs)),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length === 0 ? null : Math.max(...latencies)
    },
    scenarios: scenarios.map((scenario) => {
      const selected = own.filter((attempt) => attempt.scenario === scenario.name);
      const scenarioFailed = selected.filter((attempt) => !attempt.ok).length;
      return {
        name: scenario.name,
        targetWeight: scenario.weight,
        scheduled: record.scenarioScheduled[scenario.name],
        started: selected.length,
        succeeded: selected.length - scenarioFailed,
        failed: scenarioFailed,
        errorRate: selected.length === 0 ? 1 : scenarioFailed / selected.length,
        latencyMs: {
          p50: percentile(selected.map((attempt) => attempt.latencyMs), 0.5),
          p95: percentile(selected.map((attempt) => attempt.latencyMs), 0.95),
          p99: percentile(selected.map((attempt) => attempt.latencyMs), 0.99),
          max: selected.length === 0 ? null : Math.max(...selected.map((attempt) => attempt.latencyMs))
        }
      };
    }),
    errors: Object.fromEntries(Object.entries(own.reduce((counts, attempt) => {
      if (!attempt.ok) counts[attempt.errorCode] = (counts[attempt.errorCode] ?? 0) + 1;
      return counts;
    }, {})).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function runtimeMetadata() {
  const cpus = os.cpus();
  return {
    node: process.version,
    npmUserAgent: process.env.npm_config_user_agent ?? null,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    logicalCpuCount: cpus.length,
    availableParallelism: os.availableParallelism(),
    totalMemoryBytes: os.totalmem()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitUntil(due) {
  while (performance.now() < due) await sleep(Math.min(25, due - performance.now()));
}

function recoveryEvidence(attempts, recoveryRecord, slo) {
  const limit = Math.min(slo.recoveryWithinMs, recoveryRecord.durationMs);
  // A window may only certify recovery if it actually carried the load the
  // phase offered. Without this, one successful operation in an otherwise
  // silent window declares the system recovered - the thinnest possible
  // evidence for the gate whose whole job is to refuse missing evidence, and
  // a sparse window is itself a symptom of a target that has not recovered.
  // Derived from offered load rather than a constant, so the bar scales with
  // the profile instead of being generous at high rates and impossible at low
  // ones.
  const expectedPerWindow = recoveryRecord.arrivalRate * (slo.recoveryWindowMs / 1_000);
  const minAttempts = Math.max(1, Math.ceil(expectedPerWindow * slo.recoveryMinAttemptRatio));
  let lastWindow = null;
  for (let end = slo.recoveryWindowMs; end <= limit; end += slo.recoveryWindowMs) {
    const start = end - slo.recoveryWindowMs;
    const windowAttempts = attempts.filter((attempt) => attempt.phase === 'recovery' && attempt.startedAtMs >= recoveryRecord.startedAtMs + start && attempt.startedAtMs < recoveryRecord.startedAtMs + end);
    if (windowAttempts.length === 0) continue;
    const p95 = percentile(windowAttempts.map((attempt) => attempt.latencyMs), 0.95);
    const errorRate = windowAttempts.filter((attempt) => !attempt.ok).length / windowAttempts.length;
    lastWindow = { windowStartMs: start, windowEndMs: end, attempts: windowAttempts.length, minAttempts, p95Ms: p95, errorRate };
    if (windowAttempts.length >= minAttempts && p95 <= slo.recoveryP95MsMax && errorRate <= slo.recoveryErrorRateMax) {
      return { recovered: true, recoveredAtMs: end, ...lastWindow };
    }
  }
  return { recovered: false, recoveredAtMs: null, ...(lastWindow ?? { windowStartMs: null, windowEndMs: null, attempts: 0, minAttempts, p95Ms: null, errorRate: null }) };
}

/** Run a validated workload. Starts are clocked by offered load, never by completions. */
export async function runCapacity(profileInput) {
  const profile = validateProfile(profileInput);
  const wallStartedAt = new Date();
  const runStart = performance.now();
  const attempts = [];
  const samples = [];
  const sampleErrors = [];
  const schedulerLags = [];
  const telemetrySchedulerLags = [];
  const activeControllers = new Set();
  const inFlight = new Set();
  let phaseOffsetMs = 0;
  const phaseRecords = profile.phases.map((phase) => {
    const record = {
      ...phase,
      startedAtMs: phaseOffsetMs,
      endedAtMs: phaseOffsetMs + phase.durationMs,
      scheduled: 0,
      injectorDropped: 0,
      scenarioScheduled: Object.fromEntries(profile.scenarios.map((scenario) => [scenario.name, 0]))
    };
    phaseOffsetMs = record.endedAtMs;
    return record;
  });
  const totalDurationMs = phaseOffsetMs;
  const telemetryTicks = { expected: 0, started: 0, missed: 0 };
  let arrivalIndex = 0;

  const phaseAt = (elapsedMs) => phaseRecords.find((phase) => elapsedMs >= phase.startedAtMs && elapsedMs < phase.endedAtMs)?.name ?? null;

  const sampler = (async () => {
    for (let dueAtMs = 0; dueAtMs < totalDurationMs; dueAtMs += profile.generator.sampleIntervalMs) {
      telemetryTicks.expected += 1;
      await waitUntil(runStart + dueAtMs);
      const schedulerLagMs = Math.max(0, performance.now() - (runStart + dueAtMs));
      telemetrySchedulerLags.push(schedulerLagMs);
      if (schedulerLagMs > profile.generator.maxSchedulerLagMs) {
        telemetryTicks.missed += 1;
        continue;
      }
      telemetryTicks.started += 1;
      const controller = new AbortController();
      const timeoutError = new Error(`sample exceeded ${profile.generator.operationTimeoutMs} ms`);
      timeoutError.name = 'CapacitySampleTimeout';
      let timeout;
      const samplePhase = phaseAt(dueAtMs);
      const sampleStartedAt = performance.now();
      try {
        const metrics = await Promise.race([
          Promise.resolve().then(() => profile.sample({ target: profile.target, phase: samplePhase, elapsedMs: dueAtMs, signal: controller.signal })),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort(timeoutError);
              reject(timeoutError);
            }, profile.generator.operationTimeoutMs);
          })
        ]);
        const observedAt = performance.now();
        samples.push({ atMs: observedAt - runStart, phase: samplePhase, durationMs: observedAt - sampleStartedAt, metrics: numericMetrics(metrics) });
      } catch (error) {
        sampleErrors.push({ atMs: performance.now() - runStart, phase: samplePhase, code: error?.name ?? 'Error', message: String(error?.message ?? error) });
      } finally {
        clearTimeout(timeout);
      }
    }
  })();

  const launch = (scenario, phase, dueAtMs, sequence) => {
    if (inFlight.size >= profile.generator.maxInFlight) {
      phase.injectorDropped += 1;
      return;
    }
    const controller = new AbortController();
    activeControllers.add(controller);
    const startedAtMs = performance.now() - runStart;
    const promise = (async () => {
      const timeoutError = new Error(`operation exceeded ${profile.generator.operationTimeoutMs} ms`);
      timeoutError.name = 'CapacityOperationTimeout';
      let timeout;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => scenario.run({ target: profile.target, phase: phase.name, signal: controller.signal, arrivalIndex: sequence })),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort(timeoutError);
              reject(timeoutError);
            }, profile.generator.operationTimeoutMs);
          })
        ]);
        const normalized = result === undefined ? {} : result;
        if (!isObject(normalized)) throw new TypeError('scenario.run() must return an object or undefined');
        const completedAtMs = performance.now() - runStart;
        attempts.push({
          phase: phase.name,
          scenario: scenario.name,
          dueAtMs,
          startedAtMs,
          completedAtMs,
          // Anchored to the SCHEDULED arrival, not to the moment the injector
          // got around to starting it. An open model offers load on a clock,
          // so time spent waiting for a launch slot is delay a real client
          // would have felt; measuring from the actual start hides exactly the
          // delay that appears when the generator itself is the bottleneck,
          // which is the coordinated omission this kit exists to refuse.
          latencyMs: completedAtMs - dueAtMs,
          // The two halves, published so a reviewer can tell a slow target
          // apart from a late injector rather than inferring it.
          serviceLatencyMs: completedAtMs - startedAtMs,
          queueDelayMs: startedAtMs - dueAtMs,
          ok: normalized.ok !== false,
          status: normalized.status ?? null,
          errorCode: normalized.ok === false ? String(normalized.errorCode ?? normalized.status ?? 'FAILED') : null,
          bytesIn: nonNegative(normalized.bytesIn) ? normalized.bytesIn : null,
          bytesOut: nonNegative(normalized.bytesOut) ? normalized.bytesOut : null
        });
      } catch (error) {
        const completedAtMs = performance.now() - runStart;
        attempts.push({
          phase: phase.name,
          scenario: scenario.name,
          dueAtMs,
          startedAtMs,
          completedAtMs,
          // Anchored to the SCHEDULED arrival, not to the moment the injector
          // got around to starting it. An open model offers load on a clock,
          // so time spent waiting for a launch slot is delay a real client
          // would have felt; measuring from the actual start hides exactly the
          // delay that appears when the generator itself is the bottleneck,
          // which is the coordinated omission this kit exists to refuse.
          latencyMs: completedAtMs - dueAtMs,
          // The two halves, published so a reviewer can tell a slow target
          // apart from a late injector rather than inferring it.
          serviceLatencyMs: completedAtMs - startedAtMs,
          queueDelayMs: startedAtMs - dueAtMs,
          ok: false,
          status: null,
          errorCode: error?.name ?? 'Error',
          bytesIn: null,
          bytesOut: null
        });
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    })();
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
  };

  for (const record of phaseRecords) {
    const intervalMs = 1_000 / record.arrivalRate;
    const count = Math.floor(record.durationMs * record.arrivalRate / 1_000);
    for (let index = 0; index < count; index += 1) {
      const due = runStart + record.startedAtMs + index * intervalMs;
      await waitUntil(due);
      const lag = Math.max(0, performance.now() - due);
      schedulerLags.push(lag);
      record.scheduled += 1;
      const sequence = arrivalIndex;
      const scenario = chooseScenario(profile.scenarios, sequence);
      record.scenarioScheduled[scenario.name] += 1;
      launch(scenario, record, due - runStart, sequence);
      arrivalIndex += 1;
    }
    await waitUntil(runStart + record.endedAtMs);
  }
  await sampler;

  const drainDeadline = performance.now() + profile.generator.drainTimeoutMs;
  while (inFlight.size > 0 && performance.now() < drainDeadline) await sleep(10);
  const drainTimedOut = inFlight.size > 0;
  if (drainTimedOut) for (const controller of activeControllers) controller.abort(new Error('capacity drain timeout'));
  await Promise.allSettled([...inFlight]);

  const phaseSummaries = phaseRecords.map((record) => summarizePhase(record, attempts, profile.scenarios));
  let firstSaturatedResource = null;
  for (const sample of samples) {
    if (sample.phase !== 'overload') continue;
    for (const threshold of profile.saturation) {
      const value = metricAt(sample.metrics, threshold.metric);
      if (crossed(value, threshold)) {
        firstSaturatedResource = {
          atMs: sample.atMs,
          phase: sample.phase,
          offeredArrivalRate: profile.phases.find((phase) => phase.name === sample.phase)?.arrivalRate ?? null,
          resource: threshold.resource,
          metric: threshold.metric,
          value,
          operator: threshold.operator,
          threshold: threshold.threshold,
          unit: threshold.unit
        };
        break;
      }
    }
    if (firstSaturatedResource) break;
  }

  const expected = phaseSummaries.find((phase) => phase.name === 'expected_peak');
  const recoveryRecord = phaseRecords.find((phase) => phase.name === 'recovery');
  const recovery = recoveryEvidence(attempts, recoveryRecord, profile.slo);
  const missingTelemetryPhases = PHASES.filter((phase) => !samples.some((sample) => sample.phase === phase));
  const maximumSampleDurationMs = samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.durationMs));
  const telemetryTickEvidence = {
    ...telemetryTicks,
    schedulerLagMs: {
      p50: percentile(telemetrySchedulerLags, 0.5),
      p95: percentile(telemetrySchedulerLags, 0.95),
      p99: percentile(telemetrySchedulerLags, 0.99),
      max: telemetrySchedulerLags.length === 0 ? null : Math.max(...telemetrySchedulerLags)
    }
  };
  const integrity = {
    injectorDropped: phaseSummaries.reduce((sum, phase) => sum + phase.injectorDropped, 0),
    drainTimedOut,
    sampleErrors: sampleErrors.length,
    missingTelemetryPhases,
    maximumSampleDurationMs,
    telemetryTicks: telemetryTickEvidence,
    schedulerLagMs: {
      p50: percentile(schedulerLags, 0.5),
      p95: percentile(schedulerLags, 0.95),
      p99: percentile(schedulerLags, 0.99),
      max: schedulerLags.length === 0 ? null : Math.max(...schedulerLags)
    }
  };
  const gates = [
    { name: 'expected_peak_p95', pass: finite(expected.latencyMs.p95) && expected.latencyMs.p95 <= profile.slo.p95MsMax, actual: expected.latencyMs.p95, limit: profile.slo.p95MsMax },
    { name: 'expected_peak_p99', pass: finite(expected.latencyMs.p99) && expected.latencyMs.p99 <= profile.slo.p99MsMax, actual: expected.latencyMs.p99, limit: profile.slo.p99MsMax },
    { name: 'expected_peak_error_rate', pass: expected.errorRate <= profile.slo.errorRateMax, actual: expected.errorRate, limit: profile.slo.errorRateMax },
    { name: 'overload_saturation_witness', pass: firstSaturatedResource !== null, actual: firstSaturatedResource?.resource ?? null, limit: 'required' },
    { name: 'recovery_window', pass: recovery.recovered, actual: recovery.recoveredAtMs, limit: profile.slo.recoveryWithinMs },
    {
      name: 'injector_integrity',
      pass: integrity.injectorDropped === 0 && !integrity.drainTimedOut && integrity.sampleErrors === 0 && integrity.missingTelemetryPhases.length === 0 && integrity.telemetryTicks.expected === integrity.telemetryTicks.started && integrity.telemetryTicks.missed === 0 && finite(integrity.maximumSampleDurationMs) && integrity.maximumSampleDurationMs <= profile.generator.sampleIntervalMs && integrity.telemetryTicks.schedulerLagMs.p99 <= profile.generator.maxSchedulerLagMs && integrity.schedulerLagMs.p99 <= profile.generator.maxSchedulerLagMs,
      actual: integrity,
      limit: { injectorDropped: 0, drainTimedOut: false, sampleErrors: 0, missingTelemetryPhases: 0, telemetryTicksMissed: 0, sampleDurationMsMax: profile.generator.sampleIntervalMs, schedulerLagP99MsMax: profile.generator.maxSchedulerLagMs }
    }
  ];

  const wallFinishedAt = new Date();
  return {
    schemaVersion: 1,
    // What `latencyMs` is measured from. Earlier runs of this kit measured
    // from the actual start, which excluded injector queueing and is not
    // comparable with a scheduled-arrival measurement - and carried no field
    // saying so. Stating it makes every artifact self-describing, and an
    // artifact without it is correctly refused by the schema rather than
    // quietly compared against one that means something else.
    latencyAnchor: 'scheduled-arrival',
    runId: randomUUID(),
    profile: {
      name: profile.name,
      target: profile.target,
      expectedPeak: dataClone(profile.expectedPeak, 'expectedPeak'),
      trafficMix: profile.scenarios.map(({ name, weight, description }) => ({ name, weight, description })),
      release: dataClone(profile.release, 'release'),
      environment: dataClone(profile.environment, 'environment'),
      topology: dataClone(profile.topology, 'topology'),
      slo: dataClone(profile.slo, 'slo'),
      generator: dataClone(profile.generator, 'generator'),
      phases: dataClone(profile.phases, 'phases'),
      saturation: dataClone(profile.saturation, 'saturation')
    },
    runtime: runtimeMetadata(),
    timing: { startedAt: wallStartedAt.toISOString(), finishedAt: wallFinishedAt.toISOString(), durationMs: wallFinishedAt - wallStartedAt },
    phases: phaseSummaries,
    firstSaturatedResource,
    recovery,
    telemetry: { samples, sampleErrors },
    integrity,
    gates,
    pass: gates.every((gate) => gate.pass)
  };
}

function usage() {
  return 'Usage: node scripts/capacity/open-arrival.mjs --profile <workload.mjs> [--output <new-result.json>] [--validate]';
}

function parseArgs(argv) {
  const args = { validate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--validate') args.validate = true;
    else if (value === '--profile') args.profile = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new TypeError(`Unknown argument: ${value}`);
  }
  if (!args.help && !args.profile) throw new TypeError('--profile is required');
  if (!args.validate && !args.help && !args.output) throw new TypeError('--output is required for an evidence run');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const outputPath = args.validate ? null : path.resolve(args.output);
  let reservation = outputPath ? await open(outputPath, 'wx') : null;
  try {
    const profileUrl = pathToFileURL(path.resolve(args.profile));
    profileUrl.searchParams.set('capacityRun', randomUUID());
    const module = await import(profileUrl.href);
    const candidate = typeof module.default === 'function' ? await module.default() : module.default;
    const profile = validateProfile(candidate);
    if (args.validate) {
      console.log(`capacity profile OK: ${profile.name}`);
      return;
    }
    const result = await runCapacity(profile);
    await reservation.writeFile(`${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
    await reservation.sync();
    await reservation.close();
    reservation = null;
    console.log(`capacity ${result.pass ? 'PASS' : 'FAIL'}: ${result.profile.name}`);
    console.log(`result: ${outputPath}`);
    console.log(`peak p95/p99: ${result.phases[1].latencyMs.p95?.toFixed(2)} / ${result.phases[1].latencyMs.p99?.toFixed(2)} ms; errors: ${(result.phases[1].errorRate * 100).toFixed(3)}%`);
    console.log(`first saturation: ${result.firstSaturatedResource?.resource ?? 'not observed'}; recovery: ${result.recovery.recovered ? `${result.recovery.recoveredAtMs} ms` : 'not observed'}`);
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    if (reservation) {
      await reservation.close().catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
  });
}

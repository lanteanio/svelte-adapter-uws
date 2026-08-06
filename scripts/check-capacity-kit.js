import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { percentile, runCapacity, validateProfile } from './capacity/open-arrival.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  guide: join(root, 'docs', 'capacity', 'v1', 'README.md'),
  schema: join(root, 'docs', 'capacity', 'v1', 'result.schema.json'),
  runner: join(root, 'scripts', 'capacity', 'open-arrival.mjs'),
  readme: join(root, 'README.md'),
  operations: join(root, 'docs', 'operations', 'v1', 'README.md'),
  package: join(root, 'package.json')
};

const errors = [];
for (const [name, path] of Object.entries(paths)) {
  if (!existsSync(path)) errors.push(`missing ${name}: ${path}`);
}

function requireText(source, marker, label) {
  if (!source.includes(marker)) errors.push(`${label} is missing ${JSON.stringify(marker)}`);
}

if (errors.length === 0) {
  const guide = readFileSync(paths.guide, 'utf8');
  const runner = readFileSync(paths.runner, 'utf8');
  const readme = readFileSync(paths.readme, 'utf8');
  const operations = readFileSync(paths.operations, 'utf8');
  const pkg = JSON.parse(readFileSync(paths.package, 'utf8'));
  const schemaSource = readFileSync(paths.schema, 'utf8');
  const forbiddenControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  for (const [label, source] of [['capacity guide', guide], ['result schema', schemaSource], ['capacity runner', runner]]) {
    if (forbiddenControl.test(source)) errors.push(`${label} contains a forbidden control character`);
  }
  let schema;
  try {
    schema = JSON.parse(schemaSource);
  } catch (error) {
    errors.push(`result schema is not valid JSON: ${error.message}`);
  }

  for (const marker of [
    '## Launch gate',
    '## Required worksheet',
    '## Open-arrival semantics',
    '## Run and retain evidence',
    '## Review checklist',
    '`expectedPeak`',
    '`scenarios`',
    '`topology`',
    '`autoscaling`',
    '`firstSaturatedResource`',
    '`injectorDropped`',
    'Never edit a result into a pass',
    'create-new semantics'
  ]) requireText(guide, marker, 'capacity guide');

  for (const marker of [
    "const PHASES = ['warmup', 'expected_peak', 'overload', 'recovery']",
    'const due = runStart + record.startedAtMs + index * intervalMs',
    'telemetryTicks.expected += 1',
    'telemetryTicks.missed += 1',
    "if (sample.phase !== 'overload') continue",
    'inFlight.size >= profile.generator.maxInFlight',
    "name: 'overload_saturation_witness'",
    "name: 'recovery_window'",
    "name: 'injector_integrity'",
    "await open(outputPath, 'wx')"
  ]) requireText(runner, marker, 'capacity runner');

  requireText(readme, './docs/capacity/v1/README.md', 'README capacity route');
  requireText(operations, '../../capacity/v1/README.md', 'operations launch gate');

  const checkCommand = 'node scripts/check-capacity-kit.js';
  if (!pkg.scripts?.check?.split(' && ').includes(checkCommand)) {
    errors.push(`package scripts.check must include ${checkCommand}`);
  }
  if (pkg.scripts?.['check:capacity'] !== checkCommand) {
    errors.push('package scripts.check:capacity must run the capacity checker');
  }
  if (pkg.scripts?.['capacity:run'] !== 'node scripts/capacity/open-arrival.mjs') {
    errors.push('package scripts.capacity:run must run the open-arrival generator');
  }
  for (const packed of ['scripts/capacity/open-arrival.mjs']) {
    if (!pkg.files?.includes(packed)) errors.push(`package files must include ${packed}`);
  }

  if (schema) {
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') errors.push('result schema must use JSON Schema 2020-12');
    if (schema.properties?.schemaVersion?.const !== 1) errors.push('result schema must pin schemaVersion 1');
    // The anchor is what makes a result comparable at all - it is the reason
    // this contract did not need a version bump when latency changed meaning.
    // Pinned like the version itself, so it cannot be dropped from the schema
    // and the runner together without this saying so.
    if (schema.properties?.latencyAnchor?.const !== 'scheduled-arrival') {
      errors.push("result schema must pin latencyAnchor 'scheduled-arrival'");
    }
    for (const field of ['latencyAnchor', 'profile', 'runtime', 'timing', 'phases', 'firstSaturatedResource', 'recovery', 'telemetry', 'integrity', 'gates', 'pass']) {
      if (!schema.required?.includes(field)) errors.push(`result schema must require ${field}`);
    }
    if (schema.properties?.phases?.minItems !== 4 || schema.properties?.phases?.maxItems !== 4) errors.push('result schema must require exactly four phases');
    if (schema.properties?.gates?.minItems !== 6 || schema.properties?.gates?.maxItems !== 6) errors.push('result schema must require exactly six gates');
    if (schema.$defs?.saturationWitness?.properties?.phase?.const !== 'overload') errors.push('result schema must pin saturationWitness.phase to overload');
    for (const definition of ['profile', 'expectedPeak', 'release', 'environment', 'topology', 'autoscaling', 'slo', 'generator', 'phaseSummary', 'scenarioSummary', 'saturationWitness', 'recoveryEvidence', 'telemetry', 'integrity', 'gate']) {
      if (!schema.$defs?.[definition]) errors.push(`result schema is missing $defs.${definition}`);
    }
  }

  const sampleProfile = {
    schemaVersion: 1,
    name: 'contract-check',
    target: 'https://capacity.example.invalid',
    expectedPeak: { arrivalsPerSecond: 2, liveConnections: 1, messagesPerSecond: 1 },
    release: {
      appRevision: 'git:contract-check',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      worktree: 'clean',
      packages: {
        'svelte-adapter-uws': 'git:adapter',
        'svelte-realtime': 'git:realtime',
        'svelte-adapter-uws-extensions': 'git:extensions'
      }
    },
    environment: { location: 'test', hostClass: 'test', osImage: 'test', powerProfile: 'test', networkPath: 'test' },
    topology: {
      regions: ['test'], instancesPerRegion: 1, workersPerInstance: 1,
      cpuPerInstance: 1, memoryMiBPerInstance: 128, loadBalancer: 'test',
      dataStores: ['test'],
      autoscaling: { minInstances: 1, maxInstances: 1, signal: 'test', target: 1, cooldownSeconds: 0 }
    },
    phases: [
      { name: 'warmup', durationMs: 1_000, arrivalRate: 1 },
      { name: 'expected_peak', durationMs: 1_000, arrivalRate: 2 },
      { name: 'overload', durationMs: 1_000, arrivalRate: 3 },
      { name: 'recovery', durationMs: 1_000, arrivalRate: 1 }
    ],
    scenarios: [{ name: 'probe', weight: 1, description: 'contract probe', run() {} }],
    slo: { p95MsMax: 1, p99MsMax: 1, errorRateMax: 0, recoveryP95MsMax: 1, recoveryErrorRateMax: 0, recoveryWindowMs: 500, recoveryWithinMs: 1_000 },
    generator: { maxInFlight: 10, operationTimeoutMs: 1_000, sampleIntervalMs: 100, drainTimeoutMs: 1_000 },
    saturation: [{ resource: 'test', metric: 'test.value', operator: 'gte', threshold: 1, unit: 'ratio' }],
    sample() { return { test: { value: 1 } }; }
  };
  try {
    validateProfile(sampleProfile);
  } catch (error) {
    errors.push(`runner rejects the contract profile: ${error.message}`);
  }
  if (percentile([9, 1, 5, 3], 0.5) !== 3 || percentile([9, 1, 5, 3], 0.99) !== 9) {
    errors.push('runner percentile contract changed');
  }

  if (schema) {
    try {
      const executionProfile = {
        ...sampleProfile,
        expectedPeak: { arrivalsPerSecond: 100, liveConnections: 1, messagesPerSecond: 1 },
        phases: [
          { name: 'warmup', durationMs: 20, arrivalRate: 100 },
          { name: 'expected_peak', durationMs: 20, arrivalRate: 100 },
          { name: 'overload', durationMs: 20, arrivalRate: 200 },
          { name: 'recovery', durationMs: 20, arrivalRate: 100 }
        ],
        slo: { p95MsMax: 100, p99MsMax: 100, errorRateMax: 0, recoveryP95MsMax: 100, recoveryErrorRateMax: 0, recoveryWindowMs: 10, recoveryWithinMs: 20 },
        generator: { maxInFlight: 10, operationTimeoutMs: 100, sampleIntervalMs: 2, drainTimeoutMs: 100 },
        sample({ phase }) { return { test: { value: phase === 'overload' ? 1 : 0 } }; }
      };
      const result = await runCapacity(executionProfile);
      const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
      addFormats(ajv);
      const validateResult = ajv.compile(schema);
      if (!validateResult(result)) {
        errors.push(`generated result violates result.schema.json: ${ajv.errorsText(validateResult.errors, { separator: '; ' })}`);
      } else {
        const mutated = structuredClone(result);
        mutated.firstSaturatedResource.phase = 'warmup';
        if (validateResult(mutated)) errors.push('result schema accepts a non-overload saturation witness');
      }
    } catch (error) {
      errors.push(`executable result-schema gate failed: ${error.message}`);
    }
  }
}

if (errors.length > 0) {
  console.error('check-capacity-kit FAILED:');
  for (const error of errors) console.error(`  x ${error}`);
  process.exitCode = 1;
} else {
  console.log('capacity kit OK: version 1, 4 phases, 6 launch gates');
}

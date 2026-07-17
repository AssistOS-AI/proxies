import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deployWorkflow = await readFile(
  new URL('../.github/workflows/deploy-cliProxy.yml', import.meta.url),
  'utf8',
);
const updateWorkflow = await readFile(
  new URL('../.github/workflows/update-cliProxy.yml', import.meta.url),
  'utf8',
);
const deployReadme = await readFile(new URL('../deploy/README.md', import.meta.url), 'utf8');
const legacyDeployHelperUrl = new URL('../deploy/deploy.sh', import.meta.url);
const legacyDeployHelper = await readFile(legacyDeployHelperUrl, 'utf8');
const deployEnvExample = await readFile(new URL('../deploy/setEnv.sh.example', import.meta.url), 'utf8');
const providerKeys = await readFile(new URL('../soul-gateway/API_KEYS.md', import.meta.url), 'utf8');
const k6Stress = await readFile(new URL('../soul-gateway/k6-stress.js', import.meta.url), 'utf8');

const disabledDeploymentWorkflows = await Promise.all(
  ['copilot', 'search', 'kiro'].map(async (gateway) => ({
    gateway,
    source: await readFile(
      new URL(`../.github/workflows/deploy-${gateway}-gateway.yml`, import.meta.url),
      'utf8',
    ),
  })),
);

test('CLIProxy lifecycle uses Ploinky control and never a physical private port', () => {
  assert.match(deployWorkflow, /ploinky status/);
  assert.match(deployWorkflow, /ploinky stop cliproxyapi-gateway/);
  assert.match(deployWorkflow, /ploinky restart cliproxyapi-gateway/);
  assert.doesNotMatch(deployWorkflow, /(?:127\.0\.0\.1|localhost|10\.0\.2\.2):8317/);
  assert.doesNotMatch(deployWorkflow, /rsync[\s\S]*\.\/cliproxyapi-gateway\//);
  assert.doesNotMatch(deployWorkflow, /CLIPROXY_API_KEY|CLIPROXY_MANAGEMENT_KEY/);
});

test('deploy prepares a redacted candidate record and fails closed before activation', () => {
  assert.match(deployWorkflow, /runtime_contract=5/);
  assert.match(deployWorkflow, /source_artifact=missing/);
  assert.match(deployWorkflow, /activation=blocked/);
  assert.match(deployWorkflow, /candidate_present=false/);
  assert.match(deployWorkflow, /no remote files or lifecycle state were changed/);
  assert.match(deployWorkflow, /exit 1/);
});

test('legacy mutable updater is disabled before remote access', () => {
  assert.match(updateWorkflow, /Fail closed before remote access/);
  assert.match(updateWorkflow, /forbids mutable in-container source updates/);
  assert.doesNotMatch(updateWorkflow, /ssh |podman|git reset|:8317/);
});

test('operator documentation has no CLIProxy direct locator or committed token', () => {
  assert.match(deployReadme, /current Router locator/);
  assert.match(deployReadme, /fails closed/);
  assert.doesNotMatch(providerKeys, /10\.0\.2\.2:8317/);
  assert.doesNotMatch(providerKeys, /\bsk-[A-Za-z0-9_-]{20,}\b/);
  assert.match(providerKeys, /revoke any value previously committed here/);
});

test('unimplemented gateway deployment workflows fail before remote access', () => {
  for (const { gateway, source } of disabledDeploymentWorkflows) {
    assert.match(source, /Fail closed before remote access/, gateway);
    assert.match(source, /exit 1/, gateway);
    assert.doesNotMatch(source, /\b(?:ssh|scp|rsync|podman|curl)\b/, gateway);
    assert.doesNotMatch(source, /(?:127\.0\.0\.1|localhost|10\.0\.2\.2):(?:4141|8043|8000)/, gateway);
  }
});

test('absent runtime-v5 gateway manifests cannot be activated accidentally', () => {
  for (const manifest of [
    'cliproxyapi-gateway/manifest.json',
    'copilot-gateway/manifest.json',
    'search-gateway/manifest.json',
    'kiro-gateway/manifest.json',
  ]) {
    assert.equal(existsSync(new URL(`../${manifest}`, import.meta.url)), false, manifest);
  }
});

test('current operator documentation contains no legacy direct gateway locator', () => {
  assert.doesNotMatch(providerKeys, /10\.0\.2\.2:(?:8000|4141|8043|8317)/);
  assert.match(providerKeys, /current authenticated Router/);
  assert.match(deployReadme, /Copilot, Search, and Kiro deployment workflows/);
  assert.match(deployReadme, /stable direct target ports/);
});

test('k6 stress testing requires an injected revocable credential', () => {
  assert.match(k6Stress, /__ENV\.API_KEY/);
  assert.match(k6Stress, /API_KEY is required/);
  assert.doesNotMatch(k6Stress, /\bsk-soul-[A-Za-z0-9_-]{20,}\b/);
});

test('legacy deployment helper fails before configuration, secret, or remote access', () => {
  assert.match(legacyDeployHelper, /disabled under runtime contract v5/);
  assert.match(legacyDeployHelper, /fail before reading local configuration or contacting a remote host/);
  assert.match(legacyDeployHelper, /Do not supply credentials to this script/);
  assert.match(legacyDeployHelper, /exit 1/);
  assert.doesNotMatch(
    legacyDeployHelper,
    /PROXY_API_KEY|proxy_api_key|\b(?:source|ssh|scp|rsync|podman|curl|sed)\b|ploinky var|chmod\s+644/,
  );
});

test('legacy deployment helper runtime guard never reflects an injected credential', () => {
  const canary = 'not-a-real-secret-deploy-canary';
  const run = spawnSync(fileURLToPath(legacyDeployHelperUrl), [], {
    encoding: 'utf8',
    env: { ...process.env, PROXY_API_KEY: canary },
  });

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /legacy proxy deployment helper is disabled/);
  assert.equal(run.stderr.includes(canary), false);
});

test('deployment documentation and template cannot stage a proxy credential', () => {
  assert.match(deployReadme, /exits before[\s\S]*contacting a remote\s+host/);
  assert.match(deployReadme, /root-only \(`0600`\) secret files/);
  assert.match(deployReadme, /Do not provide credentials to `deploy\.sh`/);
  assert.doesNotMatch(deployEnvExample, /PROXY_API_KEY|openssl rand|KIRO_PORT|ANTIGRAVITY_PORT/);
});

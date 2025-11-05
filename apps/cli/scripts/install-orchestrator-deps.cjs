#!/usr/bin/env node
'use strict';

const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const orchestratorDir = path.resolve(__dirname, '../../../services/orchestrator');

function run(command, options = {}) {
  execSync(command, { stdio: 'inherit', cwd: orchestratorDir, ...options });
}

if (!existsSync(orchestratorDir)) {
  console.warn(`Orchestrator directory not found at ${orchestratorDir}; skipping dependency installation.`);
  process.exit(0);
}

const pnpmLock = existsSync(path.join(orchestratorDir, 'pnpm-lock.yaml'));
const yarnLock = existsSync(path.join(orchestratorDir, 'yarn.lock'));
const npmLock = existsSync(path.join(orchestratorDir, 'package-lock.json'));

try {
  if (pnpmLock) {
    run('pnpm install --frozen-lockfile');
  } else if (yarnLock) {
    run('yarn install --frozen-lockfile');
  } else if (npmLock) {
    run('npm ci');
  } else {
    console.warn('No lockfile detected for orchestrator dependencies; skipping install.');
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('Required package manager is not available in PATH.');
  }
  throw error;
}

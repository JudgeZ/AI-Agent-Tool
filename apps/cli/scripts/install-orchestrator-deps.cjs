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

const npmLock = existsSync(path.join(orchestratorDir, 'package-lock.json'));

try {
  if (npmLock) {
    run('npm ci');
  } else {
    console.warn('No npm lockfile detected for orchestrator dependencies; skipping install.');
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('Required package manager is not available in PATH.');
  }
  throw error;
}

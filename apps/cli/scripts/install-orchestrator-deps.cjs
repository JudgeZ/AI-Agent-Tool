#!/usr/bin/env node
'use strict';

const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const { createLogger } = require('../../../scripts/logger');

const orchestratorDir = path.resolve(__dirname, '../../../services/orchestrator');
const logger = createLogger({ name: 'install-orchestrator-deps' });

function run(command, options = {}) {
  execSync(command, { stdio: 'inherit', cwd: orchestratorDir, ...options });
}

if (!existsSync(orchestratorDir)) {
  logger.warn('Orchestrator directory not found; skipping dependency installation.', { orchestratorDir });
  process.exit(0);
}

const npmLock = existsSync(path.join(orchestratorDir, 'package-lock.json'));

try {
  if (npmLock) {
    run('npm ci');
  } else {
    logger.warn('No npm lockfile detected for orchestrator dependencies; skipping install.', {
      orchestratorDir
    });
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    logger.error('Required package manager is not available in PATH.');
  }
  throw error;
}

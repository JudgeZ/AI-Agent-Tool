#!/usr/bin/env node
import http from 'node:http';
import loggerModule from '../../../scripts/logger.js';

const { createLogger } = loggerModule;

const port = Number(process.env.MOCK_PORT || 4010);
const logger = createLogger({ name: 'mock-orchestrator' });

const plans = new Map();
const clients = new Map();

function ensurePlan(planId) {
  if (!plans.has(planId)) {
    plans.set(planId, {
      steps: {
        s1: {
          id: 's1',
          action: 'Index repository',
          capability: 'repo.read',
          capabilityLabel: 'Read repository',
          summary: 'Scanning files',
          approvalRequired: false
        },
        s2: {
          id: 's2',
          action: 'Apply workspace edits',
          capability: 'repo.write',
          capabilityLabel: 'Apply repository changes',
          summary: 'Proposed changes ready',
          approvalRequired: true,
          output: {
            diff: [
              {
                path: 'src/example.ts',
                patch: ['--- a/src/example.ts', '+++ b/src/example.ts', "@@ -1,3 +1,5 @@", "-console.log('old');", "+console.log('new');"].join('\n')
              }
            ]
          }
        },
        s3: {
          id: 's3',
          action: 'Run smoke tests',
          capability: 'test.run',
          capabilityLabel: 'Execute tests',
          summary: 'Smoke suite execution',
          approvalRequired: false
        }
      },
      awaiting: null,
      timers: []
    });
  }
  return plans.get(planId);
}

function writeEvent(planId, event, payload) {
  const sink = clients.get(planId);
  if (!sink) return;
  sink.res.write(`event: ${event}\n`);
  sink.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function schedule(planId, fn, delay) {
  const plan = ensurePlan(planId);
  const timer = setTimeout(fn, delay);
  plan.timers.push(timer);
}

function buildStepEventPayload(step, options) {
  const {
    state,
    output,
    includeTransitionTimestamp = true,
    occurredAt = new Date().toISOString(),
    transitionedAt
  } = options;
  const transitionTime = includeTransitionTimestamp ? transitionedAt ?? occurredAt : undefined;

  const stepPayload = {
    ...step,
    state
  };

  if (output !== undefined) {
    stepPayload.output = output;
  }

  if (transitionTime) {
    stepPayload.transitionedAt = transitionTime;
  }

  return {
    occurredAt,
    detail: {
      occurredAt,
      step: {
        capabilityLabel: step.capabilityLabel,
        approvalRequired: step.approvalRequired,
        ...(transitionTime ? { transitionedAt: transitionTime } : {})
      }
    },
    step: stepPayload
  };
}

function startPlan(planId) {
  const plan = ensurePlan(planId);
  const baseDelay = 250;

  const s1 = plan.steps.s1;
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s1, { state: 'queued' })
    }),
  baseDelay);
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s1, { state: 'running' })
    }),
  baseDelay * 2);
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s1, { state: 'completed' })
    }),
  baseDelay * 3);

  const s2 = plan.steps.s2;
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s2, { state: 'queued', output: s2.output })
    }),
  baseDelay * 4);
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s2, { state: 'running', output: s2.output })
    }),
  baseDelay * 5);
  schedule(planId, () => {
    plan.awaiting = s2.id;
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s2, { state: 'waiting_approval', output: s2.output })
    });
  }, baseDelay * 6);

  const s3 = plan.steps.s3;
  schedule(planId, () =>
    writeEvent(planId, 'plan.step', {
      plan_id: planId,
      ...buildStepEventPayload(s3, { state: 'queued' })
    }),
  baseDelay * 6);
}

function clearPlanTimers(planId) {
  const plan = plans.get(planId);
  if (!plan) return;
  while (plan.timers.length) {
    clearTimeout(plan.timers.pop());
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sseMatch = url.pathname.match(/^\/plan\/([^/]+)\/events$/);
  const approveMatch = url.pathname.match(/^\/plan\/([^/]+)\/steps\/([^/]+)\/approve$/);

  // MOCK ONLY: development allowlist to avoid reflecting arbitrary origins with credentials
  const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:4173']);
  const requestOrigin = req.headers.origin;

  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    res.writeHead(403);
    res.end('Origin not allowed');
    return;
  }

  const allowedOrigin = requestOrigin ?? 'http://localhost:5173';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && sseMatch) {
    const planId = decodeURIComponent(sseMatch[1]);
    ensurePlan(planId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('\n');
    clients.set(planId, { res });
    startPlan(planId);
    req.on('close', () => {
      clearPlanTimers(planId);
      clients.delete(planId);
    });
    return;
  }

  if (req.method === 'POST' && approveMatch) {
    const planId = decodeURIComponent(approveMatch[1]);
    const stepId = decodeURIComponent(approveMatch[2]);
    const plan = ensurePlan(planId);

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      let decision = 'approve';
      try {
        const parsed = body ? JSON.parse(body) : {};
        decision = parsed.decision;
      } catch {
        // ignore read errors
      }

      if (!plan.steps[stepId]) {
        res.writeHead(404);
        res.end('Step not found');
        return;
      }

      if (plan.awaiting !== stepId) {
        res.writeHead(409);
        res.end('No pending approval for this step');
        return;
      }

      if (decision === 'reject') {
        writeEvent(planId, 'plan.step', {
          plan_id: planId,
          ...buildStepEventPayload(plan.steps[stepId], { state: 'rejected' })
        });
        plan.awaiting = null;
        res.writeHead(204);
        res.end();
        return;
      }

      const approvalOccurredAt = new Date('2024-01-01T00:00:00.000Z').toISOString();
      writeEvent(planId, 'plan.step', {
        plan_id: planId,
        ...buildStepEventPayload(plan.steps[stepId], {
          state: 'approved',
          output: plan.steps[stepId].output,
          includeTransitionTimestamp: false,
          occurredAt: approvalOccurredAt
        })
      });
      plan.awaiting = null;
      schedule(planId, () =>
        writeEvent(planId, 'plan.step', {
          plan_id: planId,
          ...buildStepEventPayload(plan.steps[stepId], { state: 'completed', output: plan.steps[stepId].output })
        }),
      250);
      const s3 = plan.steps.s3;
      schedule(planId, () =>
        writeEvent(planId, 'plan.step', {
          plan_id: planId,
          ...buildStepEventPayload(s3, { state: 'running' })
        }),
      300);
      schedule(planId, () =>
        writeEvent(planId, 'plan.step', {
          plan_id: planId,
          ...buildStepEventPayload(s3, { state: 'completed' })
        }),
      650);
      res.writeHead(204);
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  logger.info('Mock orchestrator listening.', { port });
});

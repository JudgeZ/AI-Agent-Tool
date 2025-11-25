import type { PageLoad } from './$types';

type WorkflowsResponse = { workflows?: unknown[] };

export const load: PageLoad = async ({ fetch }) => {
  try {
    const response = await fetch('/workflows');
    if (!response.ok) {
      return { workflows: [], error: `Failed to load workflows (${response.status})` };
    }
    const body = (await response.json()) as WorkflowsResponse;
    return { workflows: Array.isArray(body.workflows) ? body.workflows : [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { workflows: [], error: `Failed to load workflows: ${message}` };
  }
};

import type { PageLoad } from './$types';

type CasesResponse = { cases?: unknown[] };

export const load: PageLoad = async ({ fetch }) => {
  try {
    const response = await fetch('/cases');
    if (!response.ok) {
      return { cases: [], error: `Failed to load cases (${response.status})` };
    }
    const body = (await response.json()) as CasesResponse;
    return { cases: Array.isArray(body.cases) ? body.cases : [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { cases: [], error: `Failed to load cases: ${message}` };
  }
};

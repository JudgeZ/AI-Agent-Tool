<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { gatewayOrigin, orchestratorOrigin } from '$lib/config';

  const toOrigin = (value: string | null | undefined): string | undefined => {
    if (!value) return undefined;
    try {
      return new URL(value).origin;
    } catch {
      return undefined;
    }
  };

  let status = 'pending';
  let errorMessage: string | null = null;

  onMount(() => {
    const currentUrl = new URL(window.location.href);
    const queryStatus = currentUrl.searchParams.get('status') ?? 'success';
    const queryError = currentUrl.searchParams.get('error');
    status = queryStatus;
    errorMessage = queryError;

    const payload = {
      type: 'oidc:complete',
      status: queryStatus,
      error: queryError
    };
    const candidateOrigins = [window.location.origin, orchestratorOrigin, gatewayOrigin].filter(
      (origin): origin is string => Boolean(origin)
    );
    const referrerOrigin = toOrigin(document.referrer);
    const targetOrigin =
      (referrerOrigin && candidateOrigins.includes(referrerOrigin) && referrerOrigin) || candidateOrigins[0];

    try {
      if (targetOrigin) {
        window.opener?.postMessage(payload, targetOrigin);
      }
    } catch {
      // ignore postMessage failures
    }

    if (window.opener) {
      window.close();
    } else {
      // fallback in case the page was opened directly
      setTimeout(() => {
        goto('/');
      }, 2000);
    }
  });

  $: heading = status === 'success' ? 'Authentication successful' : 'Authentication failed';
  $: message =
    status === 'success'
      ? 'You can return to the application window. This page will close automatically.'
      : errorMessage ?? 'Authentication was cancelled or failed. You may close this window.';
</script>

<main class="callback">
  <h1>{heading}</h1>
  <p>{message}</p>
</main>

<style>
  .callback {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    background: radial-gradient(circle at top, rgba(3, 105, 161, 0.35), rgba(15, 23, 42, 0.95));
    color: #e2e8f0;
    padding: 2rem;
    text-align: center;
  }

  h1 {
    font-size: 1.75rem;
    margin: 0;
  }

  p {
    max-width: 32rem;
    line-height: 1.5;
  }
</style>

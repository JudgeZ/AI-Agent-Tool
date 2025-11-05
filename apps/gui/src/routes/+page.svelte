<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import PlanTimeline from '$lib/components/PlanTimeline.svelte';
  import { timeline } from '$lib/stores/planTimeline';
  import { session as sessionStore } from '$lib/stores/session';
  import type { SessionState } from '$lib/stores/session';

  let planInput = '';
  let sessionState: SessionState = { loading: true, authenticated: false, info: null, error: null };
  const unsubscribeSession = sessionStore.subscribe((value) => {
    sessionState = value;
  });

  onMount(() => {
    sessionStore.initialize();
    const current = get(page);
    const planParam = current.url.searchParams.get('plan');
    if (planParam) {
      planInput = planParam;
      timeline.connect(planParam);
    }
  });

  onDestroy(() => {
    timeline.disconnect();
    unsubscribeSession();
  });

  const handleConnect = () => {
    const currentSession = get(sessionStore);
    if (!currentSession.authenticated) return;
    if (planInput.trim().length === 0) return;
    timeline.connect(planInput.trim());
  };

  const handleLogin = () => {
    sessionStore.login();
  };

  const handleLogout = () => {
    void sessionStore.logout();
  };

  $: authenticated = sessionState.authenticated;
  $: loadingSession = sessionState.loading;
  $: displayName =
    sessionState.info?.name || sessionState.info?.email || sessionState.info?.subject || 'User';
</script>

<main class="container">
  <section class="auth">
    {#if loadingSession}
      <span class="status">Checking session…</span>
    {:else if authenticated}
      <div class="auth__details">
        <span class="status">Signed in as {displayName}</span>
        <button class="secondary" on:click={handleLogout}>Sign out</button>
      </div>
    {:else}
      <div class="auth__details">
        <button class="primary" on:click={handleLogin}>Sign in</button>
        {#if sessionState.error}
          <span class="error">{sessionState.error}</span>
        {/if}
      </div>
    {/if}
  </section>

  <section class="controls {authenticated ? '' : 'disabled'}">
    <label for="plan">Plan ID</label>
    <div class="controls__row">
      <input
        id="plan"
        name="plan"
        placeholder="plan-1234"
        bind:value={planInput}
        disabled={!authenticated || loadingSession}
        on:keydown={(event) => event.key === 'Enter' && handleConnect()}
      />
      <button class="connect" on:click={handleConnect} disabled={!authenticated || loadingSession}>
        Connect
      </button>
    </div>
    {#if !authenticated && !loadingSession}
      <p class="hint">Sign in to connect to plan timelines and approvals.</p>
    {/if}
  </section>

  <PlanTimeline />
</main>

<style>
  .container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    margin: 0 auto;
    padding: 2rem;
    max-width: 960px;
  }

  .auth {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    box-shadow: 0 15px 35px rgba(15, 23, 42, 0.35);
  }

  .auth__details {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .status {
    font-size: 0.95rem;
    color: #cbd5f5;
  }

  .primary,
  .secondary {
    padding: 0.55rem 0.9rem;
    border-radius: 0.5rem;
    border: none;
    font-weight: 600;
    cursor: pointer;
  }

  .primary {
    background: linear-gradient(135deg, #0ea5e9, #22d3ee);
    color: #0f172a;
  }

  .primary:hover {
    filter: brightness(1.1);
  }

  .secondary {
    background: rgba(148, 163, 184, 0.25);
    color: #e2e8f0;
  }

  .secondary:hover {
    background: rgba(148, 163, 184, 0.35);
  }

  .error {
    color: #fca5a5;
    font-size: 0.85rem;
  }

  .controls {
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 0.75rem;
    padding: 1.25rem;
    box-shadow: 0 15px 35px rgba(15, 23, 42, 0.35);
  }

  .controls.disabled {
    opacity: 0.6;
  }

  .controls label {
    display: block;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.5rem;
    color: #94a3b8;
  }

  .controls__row {
    display: flex;
    gap: 0.75rem;
  }

  input {
    flex: 1;
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 0.5rem;
    padding: 0.65rem 0.85rem;
    background: rgba(15, 23, 42, 0.85);
    color: inherit;
  }

  input:focus {
    outline: 2px solid rgba(94, 234, 212, 0.6);
    outline-offset: 1px;
  }

  .connect {
    padding: 0.65rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: linear-gradient(135deg, #0ea5e9, #22d3ee);
    color: #0f172a;
    font-weight: 600;
    cursor: pointer;
  }

  .connect:disabled {
    cursor: not-allowed;
    filter: grayscale(0.6);
  }

  .connect:not(:disabled):hover {
    filter: brightness(1.1);
  }

  .hint {
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: #94a3b8;
  }
</style>

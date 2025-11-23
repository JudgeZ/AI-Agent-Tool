import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }), { virtual: true });

import Notifications from '../Notifications.svelte';
import { clearNotifications, notifyError, notifyInfo } from '$lib/stores/notifications';

describe('Notifications component', () => {
  beforeEach(() => {
    clearNotifications();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    clearNotifications();
  });

  it('renders notifications and allows manual dismissal', async () => {
    render(Notifications);

    notifyError('collaboration failed', { timeoutMs: 0 });

    expect(await screen.findByText('collaboration failed')).toBeInTheDocument();

    const dismissButton = await screen.findByRole('button', { name: /dismiss error notification/i });
    await fireEvent.click(dismissButton);

    await waitFor(() => expect(screen.queryByText('collaboration failed')).not.toBeInTheDocument());
  });

  it('auto-dismisses notifications after the timeout', async () => {
    render(Notifications);

    notifyInfo('saved layout', { timeoutMs: 1000 });

    expect(await screen.findByText('saved layout')).toBeInTheDocument();

    vi.advanceTimersByTime(1100);
    await waitFor(() => expect(screen.queryByText('saved layout')).not.toBeInTheDocument());
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ApprovalModal from '../ApprovalModal.svelte';

const mockStep = {
  id: 'step-1',
  action: 'Test Action',
  capability: 'repo.write',
  capabilityLabel: 'Write to Repository',
  tool: 'write_file',
  labels: [],
  timeoutSeconds: 30,
  state: 'waiting_approval' as const,
  approvalRequired: true,
  history: [],
  latestOutput: {},
};

describe('ApprovalModal', () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render when props are provided', () => {
      const { container } = render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null
        }
      });

      expect(container.querySelector('[role="dialog"]')).toBeInTheDocument();
    });

    it('should render details correctly', () => {
      render(ApprovalModal, {
        props: {
          step: { ...mockStep, summary: 'Test Summary' },
          submitting: false,
          error: null
        }
      });

      expect(screen.getByText('Test Action')).toBeInTheDocument();
      expect(screen.getByText('repo.write')).toBeInTheDocument();
      expect(screen.getByText('pending approval')).toBeInTheDocument();
      expect(screen.getByText('Test Summary')).toBeInTheDocument();
    });

    it('should render error when provided', () => {
      render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: 'Something went wrong'
        }
      });

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('should dispatch approve event on approve button click', async () => {
      const { component } = render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null
        }
      });

      const approveSpy = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (component as any).$on('approve', approveSpy);

      const approveButton = screen.getByText('Approve');
      await fireEvent.click(approveButton);

      expect(approveSpy).toHaveBeenCalled();
    });

    it('should dispatch reject event on reject button click', async () => {
      const { component } = render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null
        }
      });

      const rejectSpy = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (component as any).$on('reject', rejectSpy);

      const rejectButton = screen.getByText('Reject');
      await fireEvent.click(rejectButton);

      expect(rejectSpy).toHaveBeenCalled();
    });

    it('should disable buttons when submitting', () => {
      render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: true,
          error: null
        }
      });

      expect(screen.getByText('Submitting…')).toBeDisabled();
      expect(screen.getByText('Reject')).toBeDisabled();
    });
  });
});
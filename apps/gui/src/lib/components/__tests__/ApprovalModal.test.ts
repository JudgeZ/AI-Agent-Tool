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
    it('passes trimmed rationale to callbacks', async () => {
      const approveSpy = vi.fn();

      render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null,
          onApprove: approveSpy
        }
      });

      const textarea = screen.getByPlaceholderText('Leave a note about this decision');
      await fireEvent.input(textarea, { target: { value: '  ok  ' } });

      const approveButton = screen.getByText('Approve');
      await fireEvent.click(approveButton);

      expect(approveSpy).toHaveBeenCalledWith({ rationale: 'ok' });
    });

    it('should dispatch approve event on approve button click', async () => {
      const approveSpy = vi.fn();

      render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null,
          onApprove: approveSpy
        }
      });

      const approveButton = screen.getByText('Approve');
      await fireEvent.click(approveButton);

      expect(approveSpy).toHaveBeenCalled();
    });

    it('should dispatch reject event on reject button click', async () => {
      const rejectSpy = vi.fn();

      render(ApprovalModal, {
        props: {
          step: mockStep,
          submitting: false,
          error: null,
          onReject: rejectSpy
        }
      });

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

  describe('Conditional sections', () => {
    it('shows a diff when the capability writes to the repo', () => {
      render(ApprovalModal, {
        props: {
          step: { ...mockStep, capability: 'repo.write', diff: { files: [{ path: 'file.ts', patch: '-a +b' }] } },
          submitting: false,
          error: null
        }
      });

      expect(screen.getByText('Pending diff')).toBeInTheDocument();
      expect(screen.getByText('file.ts')).toBeInTheDocument();
    });

    it('lists egress requests when provided', () => {
      render(ApprovalModal, {
        props: {
          step: {
            ...mockStep,
            capability: 'network.egress',
            latestOutput: { egress_requests: [{ url: 'https://example.com', method: 'POST', reason: 'sync' }] }
          },
          submitting: false,
          error: null
        }
      });

      expect(screen.getByText('Planned network requests')).toBeInTheDocument();
      expect(screen.getByText('https://example.com')).toBeInTheDocument();
      expect(screen.getByText('POST')).toBeInTheDocument();
      expect(screen.getByText('sync')).toBeInTheDocument();
    });
  });
});
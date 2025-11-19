import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import ApprovalModal from '../ApprovalModal.svelte';

describe('ApprovalModal', () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should not render when open is false', () => {
      const { container } = render(ApprovalModal, {
        props: {
          open: false,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
    });

    it('should render when open is true', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Test Modal')).toBeInTheDocument();
    });

    it('should render title, step name, and action', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Approve File Write',
          stepName: 'Update Configuration',
          action: 'Write to config.json'
        }
      });

      expect(screen.getByText('Approve File Write')).toBeInTheDocument();
      expect(screen.getByText(/Update Configuration/)).toBeInTheDocument();
      expect(screen.getByText(/Write to config.json/)).toBeInTheDocument();
    });

    it('should render description when provided', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          description: 'This is a test description',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      expect(screen.getByText('This is a test description')).toBeInTheDocument();
    });

    it('should render Approve and Reject buttons', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    });

    it('should show loading state when loading prop is true', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: true
        }
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      expect(approveButton).toBeDisabled();
      expect(screen.getByText(/processing/i)).toBeInTheDocument();
    });

    it('should render DiffViewer when diff prop is provided', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          diff: {
            before: '{"version": "1.0.0"}',
            after: '{"version": "1.1.0"}',
            language: 'json'
          }
        }
      });

      // Verify DiffViewer is rendered (it has role="region")
      const diffRegion = screen.getByRole('region', { name: /diff/i });
      expect(diffRegion).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have role="dialog" and aria-modal="true"', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('should have aria-labelledby pointing to title', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const dialog = screen.getByRole('dialog');
      const titleId = dialog.getAttribute('aria-labelledby');

      expect(titleId).toBeTruthy();
      const titleElement = document.getElementById(titleId!);
      expect(titleElement).toHaveTextContent('Test Modal');
    });

    it('should have aria-describedby when description is provided', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          description: 'Test description',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const dialog = screen.getByRole('dialog');
      const descId = dialog.getAttribute('aria-describedby');

      expect(descId).toBeTruthy();
      const descElement = document.getElementById(descId!);
      expect(descElement).toHaveTextContent('Test description');
    });

    it('should focus first interactive element on open', async () => {
      const { rerender } = render(ApprovalModal, {
        props: {
          open: false,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      // Open modal
      await rerender({
        open: true,
        title: 'Test Modal',
        stepName: 'Test Step',
        action: 'Test Action'
      });

      await waitFor(() => {
        const rejectButton = screen.getByRole('button', { name: /reject/i });
        expect(rejectButton).toHaveFocus();
      });
    });
  });

  describe('Keyboard Trap', () => {
    it('should trap Tab key within modal (forward)', async () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      const approveButton = screen.getByRole('button', { name: /approve/i });

      // Focus reject button
      rejectButton.focus();
      expect(rejectButton).toHaveFocus();

      // Tab to approve button
      await fireEvent.keyDown(rejectButton, { key: 'Tab' });
      await waitFor(() => {
        expect(approveButton).toHaveFocus();
      });

      // Tab again should wrap to reject button
      await fireEvent.keyDown(approveButton, { key: 'Tab' });
      await waitFor(() => {
        expect(rejectButton).toHaveFocus();
      });
    });

    it('should trap Shift+Tab key within modal (backward)', async () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      const approveButton = screen.getByRole('button', { name: /approve/i });

      // Focus approve button
      approveButton.focus();
      expect(approveButton).toHaveFocus();

      // Shift+Tab to reject button
      await fireEvent.keyDown(approveButton, { key: 'Tab', shiftKey: true });
      await waitFor(() => {
        expect(rejectButton).toHaveFocus();
      });

      // Shift+Tab again should wrap to approve button
      await fireEvent.keyDown(rejectButton, { key: 'Tab', shiftKey: true });
      await waitFor(() => {
        expect(approveButton).toHaveFocus();
      });
    });

    it('should not allow focus to escape modal', async () => {
      // Create external focusable element
      const externalButton = document.createElement('button');
      externalButton.textContent = 'External';
      document.body.appendChild(externalButton);

      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      rejectButton.focus();

      // Try to Tab many times
      for (let i = 0; i < 5; i++) {
        await fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
        await waitFor(() => {
          // Focus should remain within modal
          const dialog = screen.getByRole('dialog');
          expect(dialog.contains(document.activeElement)).toBe(true);
        });
      }

      // External button should never receive focus
      expect(externalButton).not.toHaveFocus();

      document.body.removeChild(externalButton);
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('should emit approve event on Enter key', async () => {
      const approveSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('approve', approveSpy);

      await fireEvent.keyDown(document, { key: 'Enter' });

      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('should emit reject event on Escape key', async () => {
      const rejectSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('reject', rejectSpy);

      await fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(rejectSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('should not trigger Enter/Escape handlers when modal is closed', async () => {
      const approveSpy = vi.fn();
      const rejectSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: false,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('approve', approveSpy);
      component.$on('reject', rejectSpy);

      await fireEvent.keyDown(document, { key: 'Enter' });
      await fireEvent.keyDown(document, { key: 'Escape' });

      expect(approveSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
    });

    it('should activate approve button with Space key', async () => {
      const approveSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('approve', approveSpy);

      const approveButton = screen.getByRole('button', { name: /approve/i });
      approveButton.focus();

      await fireEvent.keyDown(approveButton, { key: ' ' });

      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Button Interactions', () => {
    it('should emit approve event when Approve button is clicked', async () => {
      const approveSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('approve', approveSpy);

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await fireEvent.click(approveButton);

      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('should emit reject event when Reject button is clicked', async () => {
      const rejectSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('reject', rejectSpy);

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      await fireEvent.click(rejectButton);

      await waitFor(() => {
        expect(rejectSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('should disable buttons when loading is true', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: true
        }
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      const rejectButton = screen.getByRole('button', { name: /reject/i });

      expect(approveButton).toBeDisabled();
      expect(rejectButton).toBeDisabled();
    });

    it('should not emit events when buttons are disabled', async () => {
      const approveSpy = vi.fn();
      const rejectSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: true
        }
      });

      component.$on('approve', approveSpy);
      component.$on('reject', rejectSpy);

      const approveButton = screen.getByRole('button', { name: /approve/i });
      const rejectButton = screen.getByRole('button', { name: /reject/i });

      await fireEvent.click(approveButton);
      await fireEvent.click(rejectButton);

      expect(approveSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
    });
  });

  describe('Backdrop Interaction', () => {
    it('should emit close event when backdrop is clicked (if allowBackdropClose is true)', async () => {
      const closeSpy = vi.fn();
      const { component, container } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          allowBackdropClose: true
        }
      });

      component.$on('close', closeSpy);

      const backdrop = container.querySelector('.modal-backdrop');
      expect(backdrop).toBeInTheDocument();

      await fireEvent.click(backdrop!);

      await waitFor(() => {
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('should not emit close event when backdrop is clicked (if allowBackdropClose is false)', async () => {
      const closeSpy = vi.fn();
      const { component, container } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          allowBackdropClose: false
        }
      });

      component.$on('close', closeSpy);

      const backdrop = container.querySelector('.modal-backdrop');
      await fireEvent.click(backdrop!);

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('should not emit close event when modal content is clicked', async () => {
      const closeSpy = vi.fn();
      const { component } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          allowBackdropClose: true
        }
      });

      component.$on('close', closeSpy);

      const dialog = screen.getByRole('dialog');
      await fireEvent.click(dialog);

      expect(closeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Focus Restoration', () => {
    it('should restore focus to previously focused element after close', async () => {
      // Create external button
      const externalButton = document.createElement('button');
      externalButton.textContent = 'External';
      document.body.appendChild(externalButton);
      externalButton.focus();
      expect(externalButton).toHaveFocus();

      // Open modal
      const { rerender } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      // Modal should steal focus
      await waitFor(() => {
        expect(externalButton).not.toHaveFocus();
      });

      // Close modal
      await rerender({
        open: false,
        title: 'Test Modal',
        stepName: 'Test Step',
        action: 'Test Action'
      });

      // Focus should be restored
      await waitFor(() => {
        expect(externalButton).toHaveFocus();
      });

      document.body.removeChild(externalButton);
    });

    it('should restore focus after reject', async () => {
      // Create external button
      const externalButton = document.createElement('button');
      externalButton.textContent = 'External';
      document.body.appendChild(externalButton);
      externalButton.focus();

      const { component, rerender } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      component.$on('reject', async () => {
        // Close modal on reject
        await rerender({
          open: false,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        });
      });

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      await fireEvent.click(rejectButton);

      await waitFor(() => {
        expect(externalButton).toHaveFocus();
      });

      document.body.removeChild(externalButton);
    });
  });

  describe('Diff Integration', () => {
    it('should pass diff props to DiffViewer', () => {
      const diff = {
        before: 'const x = 1;',
        after: 'const x = 2;',
        language: 'typescript'
      };

      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          diff
        }
      });

      const diffRegion = screen.getByRole('region', { name: /diff/i });
      expect(diffRegion).toBeInTheDocument();
      // DiffViewer should render the diff content
      expect(diffRegion).toHaveTextContent(/const x/);
    });

    it('should not render DiffViewer when diff is not provided', () => {
      const { container } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should show loading indicator when loading is true', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: true
        }
      });

      expect(screen.getByText(/processing/i)).toBeInTheDocument();
    });

    it('should disable both buttons when loading is true', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: true
        }
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      const rejectButton = screen.getByRole('button', { name: /reject/i });

      expect(approveButton).toBeDisabled();
      expect(rejectButton).toBeDisabled();
    });

    it('should not show loading indicator when loading is false', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action',
          loading: false
        }
      });

      expect(screen.queryByText(/processing/i)).not.toBeInTheDocument();
    });
  });

  describe('Multiple Modals', () => {
    it('should handle multiple modals without conflicts', async () => {
      const { container: container1 } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Modal 1',
          stepName: 'Step 1',
          action: 'Action 1'
        }
      });

      const { container: container2 } = render(ApprovalModal, {
        props: {
          open: true,
          title: 'Modal 2',
          stepName: 'Step 2',
          action: 'Action 2'
        }
      });

      expect(screen.getByText('Modal 1')).toBeInTheDocument();
      expect(screen.getByText('Modal 2')).toBeInTheDocument();

      // Both modals should have unique IDs
      const dialog1 = container1.querySelector('[role="dialog"]');
      const dialog2 = container2.querySelector('[role="dialog"]');

      const labelId1 = dialog1?.getAttribute('aria-labelledby');
      const labelId2 = dialog2?.getAttribute('aria-labelledby');

      expect(labelId1).not.toBe(labelId2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid open/close cycles', async () => {
      const { rerender } = render(ApprovalModal, {
        props: {
          open: false,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      // Rapidly toggle open/close
      for (let i = 0; i < 10; i++) {
        await rerender({
          open: i % 2 === 0,
          title: 'Test Modal',
          stepName: 'Test Step',
          action: 'Test Action'
        });
      }

      // Modal should be closed (i = 9, odd)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should handle empty title gracefully', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: '',
          stepName: 'Test Step',
          action: 'Test Action'
        }
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });

    it('should handle very long text content', () => {
      const longText = 'A'.repeat(10000);

      render(ApprovalModal, {
        props: {
          open: true,
          title: longText,
          stepName: longText,
          action: longText
        }
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      // Modal should not overflow or break layout
    });

    it('should handle special characters in props', () => {
      render(ApprovalModal, {
        props: {
          open: true,
          title: '<script>alert("XSS")</script>',
          stepName: '"><img src=x onerror=alert(1)>',
          action: "'; DROP TABLE users; --"
        }
      });

      // Text should be escaped, not executed
      expect(screen.getByText('<script>alert("XSS")</script>')).toBeInTheDocument();
    });
  });
});

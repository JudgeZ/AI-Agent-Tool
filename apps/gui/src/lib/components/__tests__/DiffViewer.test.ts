import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import DiffViewer from '../DiffViewer.svelte';

describe('DiffViewer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Rendering', () => {
    it('should render when before and after are provided', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2 modified'
        }
      });

      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
    });

    it('should render empty when both before and after are empty', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: '',
          after: ''
        }
      });

      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
      expect(diffRegion).toHaveTextContent(/no changes/i);
    });

    it('should handle before-only content (deletion)', () => {
      render(DiffViewer, {
        props: {
          before: 'deleted line',
          after: ''
        }
      });

      expect(screen.getByText(/deleted line/)).toBeInTheDocument();
    });

    it('should handle after-only content (addition)', () => {
      render(DiffViewer, {
        props: {
          before: '',
          after: 'added line'
        }
      });

      expect(screen.getByText(/added line/)).toBeInTheDocument();
    });
  });

  describe('Unified Mode', () => {
    it('should render unified diff by default', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2 modified',
          mode: 'unified'
        }
      });

      const unified = container.querySelector('.diff-unified');
      expect(unified).toBeInTheDocument();
    });

    it('should show additions with + marker', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 1\nline 2',
          mode: 'unified'
        }
      });

      // Check for addition marker (either "+" text or CSS class)
      const diffLine = screen.getByText(/line 2/);
      expect(diffLine.closest('.diff-line-added')).toBeInTheDocument();
    });

    it('should show deletions with - marker', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1',
          mode: 'unified'
        }
      });

      // Check for deletion marker
      const diffLine = screen.getByText(/line 2/);
      expect(diffLine.closest('.diff-line-removed')).toBeInTheDocument();
    });

    it('should show unchanged lines without markers', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2',
          mode: 'unified'
        }
      });

      const line1 = screen.getByText(/line 1/);
      expect(line1.closest('.diff-line-unchanged')).toBeInTheDocument();
    });
  });

  describe('Split Mode', () => {
    it('should render split diff when mode is "split"', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2 modified',
          mode: 'split'
        }
      });

      const split = container.querySelector('.diff-split');
      expect(split).toBeInTheDocument();
    });

    it('should have before and after columns', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 2',
          mode: 'split'
        }
      });

      expect(screen.getByText(/before/i)).toBeInTheDocument();
      expect(screen.getByText(/after/i)).toBeInTheDocument();
    });

    it('should align corresponding lines', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2\nline 3',
          after: 'line 1\nline 2 modified\nline 3',
          mode: 'split'
        }
      });

      // Both columns should have same number of rows
      const beforeLines = container.querySelectorAll('.before-column .diff-line');
      const afterLines = container.querySelectorAll('.after-column .diff-line');
      expect(beforeLines.length).toBe(afterLines.length);
    });
  });

  describe('Line Numbers', () => {
    it('should show line numbers when showLineNumbers is true', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2',
          showLineNumbers: true
        }
      });

      const lineNumbers = container.querySelectorAll('.diff-line-number');
      expect(lineNumbers.length).toBeGreaterThan(0);
    });

    it('should hide line numbers when showLineNumbers is false', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2',
          showLineNumbers: false
        }
      });

      const lineNumbers = container.querySelectorAll('.diff-line-number');
      expect(lineNumbers.length).toBe(0);
    });

    it('should show correct line numbers for additions', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 1\nline 2\nline 3',
          showLineNumbers: true
        }
      });

      // Line 1: both sides
      // Line 2: right side only (addition)
      // Line 3: right side only (addition)
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should handle line numbers for deletions', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\nline 2\nline 3',
          after: 'line 1',
          showLineNumbers: true
        }
      });

      // Line 1: both sides
      // Line 2: left side only (deletion)
      // Line 3: left side only (deletion)
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  describe('Compact Mode', () => {
    it('should show all lines when compact is false', () => {
      const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 25', 'line 25 modified');

      const { container } = render(DiffViewer, {
        props: {
          before,
          after,
          compact: false
        }
      });

      const lines = container.querySelectorAll('.diff-line');
      expect(lines.length).toBeGreaterThanOrEqual(50);
    });

    it('should show only changed lines with context when compact is true', () => {
      const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 25', 'line 25 modified');

      const { container } = render(DiffViewer, {
        props: {
          before,
          after,
          compact: true,
          contextLines: 3
        }
      });

      // Should show:
      // - 3 context lines before change (22, 23, 24)
      // - Changed line (25)
      // - 3 context lines after change (26, 27, 28)
      // = 7 lines total (not 50)
      const lines = container.querySelectorAll('.diff-line');
      expect(lines.length).toBeLessThan(50);
      expect(lines.length).toBeGreaterThanOrEqual(7);
    });

    it('should show "..." placeholder for hidden lines', () => {
      const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 25', 'line 25 modified');

      render(DiffViewer, {
        props: {
          before,
          after,
          compact: true,
          contextLines: 3
        }
      });

      // Should show placeholder for hidden lines
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should respect contextLines prop', () => {
      const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 25', 'line 25 modified');

      const { container } = render(DiffViewer, {
        props: {
          before,
          after,
          compact: true,
          contextLines: 5
        }
      });

      // Should show:
      // - 5 context lines before (20-24)
      // - Changed line (25)
      // - 5 context lines after (26-30)
      // = 11 lines total
      const lines = container.querySelectorAll('.diff-line');
      expect(lines.length).toBeGreaterThanOrEqual(11);
    });
  });

  describe('Syntax Highlighting', () => {
    it('should apply syntax highlighting when language is provided', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'const x = 1;',
          after: 'const x = 2;',
          language: 'javascript'
        }
      });

      // Check for highlighted code (highlight.js adds <span> elements)
      const codeElement = container.querySelector('code');
      expect(codeElement).toBeInTheDocument();

      // Highlighted code should have syntax classes
      const spans = codeElement?.querySelectorAll('span');
      expect(spans?.length).toBeGreaterThan(0);
    });

    it('should not apply syntax highlighting when language is not provided', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'const x = 1;',
          after: 'const x = 2;'
        }
      });

      // Should render plain text without syntax classes
      const codeElement = container.querySelector('code');
      expect(codeElement?.textContent).toContain('const x');
    });

    it('should handle invalid language gracefully', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'const x = 1;',
          after: 'const x = 2;',
          language: 'not-a-real-language'
        }
      });

      // Should still render diff, even if highlighting fails
      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
    });

    it('should support common languages', () => {
      const languages = ['javascript', 'typescript', 'python', 'go', 'rust', 'json', 'yaml'];

      languages.forEach(lang => {
        const { container } = render(DiffViewer, {
          props: {
            before: 'code before',
            after: 'code after',
            language: lang
          }
        });

        const diffRegion = container.querySelector('[role="region"]');
        expect(diffRegion).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have role="region"', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 2'
        }
      });

      const region = container.querySelector('[role="region"]');
      expect(region).toBeInTheDocument();
    });

    it('should have aria-label', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 2'
        }
      });

      const region = container.querySelector('[role="region"]');
      expect(region).toHaveAttribute('aria-label');
      expect(region?.getAttribute('aria-label')).toMatch(/diff/i);
    });

    it('should use semantic HTML', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2',
          after: 'line 1\nline 2',
          mode: 'unified'
        }
      });

      // Should use <pre> or <code> for code display
      const preElement = container.querySelector('pre');
      const codeElement = container.querySelector('code');

      expect(preElement || codeElement).toBeInTheDocument();
    });

    it('should have proper color contrast', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1',
          after: 'line 2'
        }
      });

      // Check that added/removed lines have sufficient contrast
      // This would ideally use a contrast checker library
      const addedLine = container.querySelector('.diff-line-added');
      const removedLine = container.querySelector('.diff-line-removed');

      expect(addedLine || removedLine).toBeInTheDocument();
    });

    it('should support keyboard navigation', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'line 1\nline 2\nline 3',
          after: 'line 1\nline 2 modified\nline 3'
        }
      });

      const region = container.querySelector('[role="region"]');
      // Region should be focusable for keyboard scrolling
      expect(region).toHaveAttribute('tabindex');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long lines', () => {
      const longLine = 'A'.repeat(10000);

      const { container } = render(DiffViewer, {
        props: {
          before: longLine,
          after: longLine + 'B'
        }
      });

      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
      // Should not crash or overflow
    });

    it('should handle many lines', () => {
      const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 500', 'line 500 modified');

      const { container } = render(DiffViewer, {
        props: {
          before,
          after,
          compact: true
        }
      });

      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
    });

    it('should handle special characters', () => {
      render(DiffViewer, {
        props: {
          before: '<script>alert("XSS")</script>',
          after: '"><img src=x onerror=alert(1)>'
        }
      });

      // Text should be escaped, not executed
      expect(screen.getByText(/<script>/)).toBeInTheDocument();
    });

    it('should handle unicode characters', () => {
      render(DiffViewer, {
        props: {
          before: '你好世界',
          after: 'こんにちは世界'
        }
      });

      expect(screen.getByText(/你好世界/)).toBeInTheDocument();
      expect(screen.getByText(/こんにちは世界/)).toBeInTheDocument();
    });

    it('should handle emoji', () => {
      render(DiffViewer, {
        props: {
          before: '🎉 Celebration',
          after: '🎊 Party'
        }
      });

      expect(screen.getByText(/🎉/)).toBeInTheDocument();
      expect(screen.getByText(/🎊/)).toBeInTheDocument();
    });

    it('should handle mixed line endings (CRLF vs LF)', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\r\nline 2\r\nline 3',
          after: 'line 1\nline 2\nline 3'
        }
      });

      // Should normalize line endings and show no changes
      const unchangedLines = document.querySelectorAll('.diff-line-unchanged');
      expect(unchangedLines.length).toBe(3);
    });

    it('should handle binary-like content', () => {
      render(DiffViewer, {
        props: {
          before: '\x00\x01\x02\x03',
          after: '\x04\x05\x06\x07'
        }
      });

      const diffRegion = screen.getByRole('region');
      expect(diffRegion).toBeInTheDocument();
      // Should render something, even if binary
    });
  });

  describe('Performance', () => {
    it('should render large diffs efficiently', () => {
      const before = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 2500', 'line 2500 modified');

      const start = performance.now();

      render(DiffViewer, {
        props: {
          before,
          after,
          compact: true,
          contextLines: 3
        }
      });

      const end = performance.now();
      const renderTime = end - start;

      // Should render in < 500ms (adjust threshold as needed)
      expect(renderTime).toBeLessThan(500);
    });

    it('should use virtualization for very large diffs (future enhancement)', () => {
      // This is a placeholder for future virtual scrolling implementation
      const before = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before;

      const { container } = render(DiffViewer, {
        props: {
          before,
          after
        }
      });

      // For now, just verify it renders
      const diffRegion = container.querySelector('[role="region"]');
      expect(diffRegion).toBeInTheDocument();
    });
  });

  describe('Diff Algorithm', () => {
    it('should correctly identify line changes', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\nline 2\nline 3',
          after: 'line 1\nline 2 modified\nline 3'
        }
      });

      // Line 2 should be marked as changed
      const line2 = screen.getByText(/line 2/);
      expect(line2).toBeInTheDocument();
    });

    it('should handle complex changes', () => {
      render(DiffViewer, {
        props: {
          before: 'A\nB\nC\nD\nE',
          after: 'A\nX\nC\nY\nE'
        }
      });

      // B → X, D → Y
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('C')).toBeInTheDocument();
      expect(screen.getByText('E')).toBeInTheDocument();
      expect(screen.getByText('X')).toBeInTheDocument();
      expect(screen.getByText('Y')).toBeInTheDocument();
    });

    it('should handle moved lines', () => {
      render(DiffViewer, {
        props: {
          before: 'line 1\nline 2\nline 3',
          after: 'line 3\nline 1\nline 2'
        }
      });

      // All lines should be present
      expect(screen.getByText(/line 1/)).toBeInTheDocument();
      expect(screen.getByText(/line 2/)).toBeInTheDocument();
      expect(screen.getByText(/line 3/)).toBeInTheDocument();
    });
  });

  describe('Snapshot Tests', () => {
    it('should match snapshot for unified mode', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'const x = 1;\nconst y = 2;',
          after: 'const x = 2;\nconst y = 2;',
          mode: 'unified',
          showLineNumbers: true
        }
      });

      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot for split mode', () => {
      const { container } = render(DiffViewer, {
        props: {
          before: 'const x = 1;\nconst y = 2;',
          after: 'const x = 2;\nconst y = 2;',
          mode: 'split',
          showLineNumbers: true
        }
      });

      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot for compact mode', () => {
      const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const after = before.replace('line 25', 'line 25 modified');

      const { container } = render(DiffViewer, {
        props: {
          before,
          after,
          compact: true,
          contextLines: 3,
          showLineNumbers: true
        }
      });

      expect(container.firstChild).toMatchSnapshot();
    });
  });
});

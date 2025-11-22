import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import DiffViewer from '../DiffViewer.svelte';

describe('DiffViewer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should render list of changed files', () => {
    render(DiffViewer, {
      props: {
        diff: {
          files: [
            { path: 'file1.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
            { path: 'file2.ts', patch: '@@ -0,0 +1,1 @@\n+added' }
          ]
        }
      }
    });

    expect(screen.getByText('file1.ts')).toBeInTheDocument();
    expect(screen.getByText('file2.ts')).toBeInTheDocument();
    
    // Patches are rendered inside code blocks
    expect(screen.getByText(/old/)).toBeInTheDocument();
    expect(screen.getByText(/new/)).toBeInTheDocument();
    expect(screen.getByText(/added/)).toBeInTheDocument();
  });

  it('should render nothing if files list is empty', () => {
    const { container } = render(DiffViewer, {
      props: {
        diff: { files: [] }
      }
    });

    const sections = container.querySelectorAll('.diff-file');
    expect(sections.length).toBe(0);
  });
});

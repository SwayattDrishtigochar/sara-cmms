import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../layout/AppShell.jsx';
import { Button } from './core.jsx';

vi.mock('../auth/useAuth.js', () => ({ useSession: () => null }));
vi.mock('../layout/Header.jsx', () => ({ Header: () => null }));
vi.mock('../layout/Sidebar.jsx', () => ({ Sidebar: () => null, SidebarContent: () => null }));

afterEach(cleanup);

// Run from client/ (vitest root); Vite's ?raw import yields '' for CSS under vitest.
const css = readFileSync('src/index.css', 'utf8');
const tokens = (selector) => {
  const block = css.slice(css.indexOf(`${selector} {`));
  const body = block.slice(0, block.indexOf('}'));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('Button colours', () => {
  it('ai and danger buttons use the theme foreground, not fixed white', () => {
    for (const variant of ['ai', 'danger']) {
      render(<Button variant={variant}>{variant}</Button>);
      const cls = screen.getByRole('button', { name: variant }).className;
      expect(cls).toContain('text-brand-fg');
      expect(cls).not.toContain('text-white');
    }
  });

  it('that foreground meets WCAG AA on brand, ai and critical in light and dark', () => {
    for (const selector of [':root', '.dark']) {
      const t = { ...tokens(':root'), ...tokens(selector) };
      for (const bg of ['brand', 'ai', 'critical']) {
        expect(contrast(t['brand-fg'], t[bg]), `${selector} ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('AppShell', () => {
  it('main is the containing block, so absolute sr-only children cannot stretch the document', () => {
    const { container } = render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    expect(container.querySelector('main').className.split(' ')).toContain('relative');
  });
});

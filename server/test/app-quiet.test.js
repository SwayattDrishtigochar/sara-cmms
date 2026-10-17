import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('createApp', () => {
  it('builds the app without writing to the console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createApp();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

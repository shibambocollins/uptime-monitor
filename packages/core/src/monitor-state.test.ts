import { describe, expect, it } from 'vitest';
import { worstState } from './monitor-state';

describe('worstState', () => {
  it('returns null when there are no monitors', () => {
    expect(worstState([])).toBeNull();
  });

  it('returns UP when every monitor is up', () => {
    expect(worstState(['UP', 'UP'])).toBe('UP');
  });

  it('ranks DEGRADED above UP', () => {
    expect(worstState(['UP', 'DEGRADED', 'UP'])).toBe('DEGRADED');
  });

  it('ranks DOWN above everything, regardless of order', () => {
    expect(worstState(['DOWN', 'DEGRADED', 'UP'])).toBe('DOWN');
    expect(worstState(['UP', 'DEGRADED', 'DOWN'])).toBe('DOWN');
  });
});

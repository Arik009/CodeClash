import { describe, expect, it } from 'vitest';
import {
  canTransition,
} from './index.js';

describe('rules', () => {
  it('rejects illegal contest jumps', () => {
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('draft', 'registration_open')).toBe(true);
    expect(canTransition('running', 'frozen')).toBe(true);
  });

  it('allows cancelling a contest that has not published', () => {
    expect(canTransition('registration_open', 'cancelled')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
    expect(canTransition('published', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
  });
});

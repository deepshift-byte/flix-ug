import { describe, it, expect } from 'vitest';
import { priceFor } from '../src/pricing';

describe('priceFor', () => {
  it('prices a movie at 1000', () => {
    expect(priceFor('movie', 1)).toBe(1000);
  });
  it('prices a series of 10 episodes at 1000', () => {
    expect(priceFor('series', 10)).toBe(1000);
  });
  it('prices a series of 11 episodes at 2000', () => {
    expect(priceFor('series', 11)).toBe(2000);
  });
  it('prices a series of 20 episodes at 2000', () => {
    expect(priceFor('series', 20)).toBe(2000);
  });
  it('rejects a series with zero or negative episodes', () => {
    expect(() => priceFor('series', 0)).toThrow();
  });
});

export type TitleKind = 'movie' | 'series';

const SINGLE_PRICE_UGX = 1000;
const LONG_SERIES_PRICE_UGX = 2000;
const LONG_SERIES_THRESHOLD = 10;

export function priceFor(kind: TitleKind, episodes: number): number {
  if (kind === 'movie') return SINGLE_PRICE_UGX;
  if (!Number.isInteger(episodes) || episodes < 1) {
    throw new RangeError(`series must have at least 1 episode, got ${episodes}`);
  }
  return episodes > LONG_SERIES_THRESHOLD ? LONG_SERIES_PRICE_UGX : SINGLE_PRICE_UGX;
}

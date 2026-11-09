import { describe, expect, it, beforeAll } from 'vitest';
import { computeOpportunity, classifyIntent, clusterByTokens, morphologicalVariants } from '../src/services/keywords/engine.js';
import type { CompetitionAnalysis } from '../src/services/keywords/engine.js';

describe('keyword engine', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  const baseAnalysis = (overrides: Partial<CompetitionAnalysis>): CompetitionAnalysis => ({
    keyword: 'test keyword',
    totalResultsEstimate: 50_000,
    sampleSize: 10,
    topVideos: [],
    medianTopViews: 10_000,
    p25TopViews: 5_000,
    exactMatchTitleRatio: 0.5,
    medianChannelSubs: 100_000,
    medianAgeDays: 120,
    recentUploadMedianViews: null,
    shortsShareInTop: 0,
    ...overrides,
  });

  it('gives a high opportunity to weak competition', () => {
    const weak = computeOpportunity(
      baseAnalysis({ medianTopViews: 500, medianChannelSubs: 1_000, exactMatchTitleRatio: 0.1, medianAgeDays: 400 }),
    );
    const strong = computeOpportunity(
      baseAnalysis({ medianTopViews: 2_000_000, medianChannelSubs: 8_000_000, exactMatchTitleRatio: 0.9, medianAgeDays: 10 }),
    );
    expect(weak.opportunity).toBeGreaterThan(strong.opportunity + 30);
    expect(weak.opportunity).toBeGreaterThanOrEqual(0);
    expect(weak.opportunity).toBeLessThanOrEqual(100);
  });

  it('boosts opportunity when fresh uploads perform well', () => {
    const withFresh = computeOpportunity(baseAnalysis({ recentUploadMedianViews: 50_000 }));
    const withoutFresh = computeOpportunity(baseAnalysis({ recentUploadMedianViews: 100 }));
    expect(withFresh.opportunity).toBeGreaterThan(withoutFresh.opportunity);
  });

  it('classifies intent patterns', () => {
    expect(classifyIntent('how to edit videos').intent).toBe('informational');
    expect(classifyIntent('best camera for youtube').intent).toBe('commercial');
    expect(classifyIntent('davinci resolve tutorial').intent).toBe('educational');
    expect(classifyIntent('funny cat compilation').intent).toBe('entertainment');
  });

  it('expands morphological variants around the seed', () => {
    const variants = morphologicalVariants('home workout');
    expect(variants).toContain('home workout tutorial');
    expect(variants.some((v) => v.startsWith('how to '))).toBe(true);
  });

  it('clusters keywords by leading tokens', () => {
    const clusters = clusterByTokens(['video editing tips', 'video editing software', 'thumbnail design', 'thumbnail psychology']);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });
});

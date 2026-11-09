import { describe, expect, it } from 'vitest';
import { computeSeoScore } from '../src/services/seo/scorer.js';

describe('SEO scorer', () => {
  it('scores a fully optimized video highly', () => {
    const result = computeSeoScore({
      title: 'Notion Tutorial for Beginners: Build a Second Brain in 2026',
      description:
        'Learn how to build a second brain in Notion. This notion tutorial walks through the full system step by step. ' +
        'Timestamps:\n0:00 Intro\n1:20 Setup\n5:40 Databases\n12:00 Automations\n\nSubscribe for more Notion tutorials every week.\nhttps://example.com\n#notion #productivity',
      tags: ['notion tutorial', 'notion for beginners', 'second brain', 'notion tips', 'productivity system', 'notion 2026', 'how to use notion', 'notion setup'],
      keyword: 'notion tutorial',
    });
    expect(result.overall).toBeGreaterThanOrEqual(80);
    expect(result.grade).toBe('A');
  });

  it('scores an empty-description, keywordless video poorly', () => {
    const result = computeSeoScore({
      title: 'vlog',
      description: '',
      tags: [],
    });
    expect(result.overall).toBeLessThan(45);
    expect(result.grade === 'D' || result.grade === 'F').toBe(true);
  });

  it('penalizes missing keyword in title but rewards placement when present', () => {
    const missing = computeSeoScore({
      title: 'I tried waking up at 5am for a month (results were wild)',
      description: 'In this video we test the 5am routine and what actually happened.',
      tags: ['5am', 'routine'],
      keyword: 'morning routine',
    });
    const present = computeSeoScore({
      title: 'Morning Routine 2026: The 5AM System That Actually Stuck',
      description:
        'This morning routine video breaks down the 5AM system step by step. The morning routine habit took 30 days to stick. Timestamps:\n0:00 Intro\n2:00 Wake up\n4:00 Deep work',
      tags: ['morning routine', '5am routine', 'morning routine 2026', 'habit system'],
      keyword: 'morning routine',
    });
    expect(present.overall).toBeGreaterThan(missing.overall + 15);
  });

  it('is deterministic', () => {
    const input = { title: 'Test Title for Scoring Determinism', description: 'A description about testing determinism.', tags: ['testing'] };
    expect(computeSeoScore(input).overall).toBe(computeSeoScore(input).overall);
  });

  it('never returns a score above 100 or below 0', () => {
    const result = computeSeoScore({ title: 'x'.repeat(150), description: 'y'.repeat(9000), tags: Array.from({ length: 50 }, (_, i) => `tag ${i}`) });
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
  });
});

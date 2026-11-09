import type { SeoComponentScore, SeoFinding, SeoFindingLevel, SeoScoreResult } from '@cia/shared';

/**
 * Transparent, rule-based SEO scoring. Every component is explained and every
 * finding carries its confidence level. There is NO ranking guarantee anywhere:
 * this score measures metadata quality, not search outcomes.
 *
 * Components and weights:
 *  - title: 30   (length, keyword placement, structure, clickbait hygiene)
 *  - description: 25 (length, keyword in first 150 chars, structure, links, hashtags)
 *  - tags: 15 (coverage, count, keyword matches)
 *  - keywordFocus: 20 (target keyword presence across metadata)
 *  - freshness: 10 (publication age relative opportunity note)
 */

const TITLE_MIN = 30;
const TITLE_MAX = 70;
const DESC_MIN = 250;
const DESC_FIRST_KEYWORD_ZONE = 150;
const HASHTAG_LIMIT = 3;

export interface SeoScoreInput {
  title: string;
  description: string;
  tags: string[];
  keyword?: string;
  publishedAt?: Date;
  isShort?: boolean;
}

function level(scoreRatio: number): SeoFindingLevel {
  if (scoreRatio >= 0.8) return 'good';
  if (scoreRatio >= 0.5) return 'warning';
  return 'critical';
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function keywordIn(keyword: string, text: string): boolean {
  if (!keyword) return false;
  const k = normalize(keyword);
  if (k.length < 3) return false;
  // token-subset match: every keyword token must appear in the text
  const tokens = k.split(' ').filter((t) => t.length >= 3);
  if (tokens.length === 0) return normalize(text).includes(k);
  return tokens.every((t) => normalize(text).includes(t));
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

function scoreTitle(input: SeoScoreInput): SeoComponentScore {
  const findings: SeoFinding[] = [];
  let score = 0;
  const title = input.title.trim();
  const len = title.length;

  // Length (max 10)
  if (len === 0) {
    findings.push({ component: 'title', level: 'critical', title: 'Title is empty', detail: 'A video without a title cannot rank or attract clicks.', recommendation: 'Write a 30-70 character title containing the main keyword.', confidence: 'high' });
  } else if (len >= TITLE_MIN && len <= TITLE_MAX) {
    score += 10;
    findings.push({ component: 'title', level: 'good', title: `Title length is good (${len} chars)`, detail: 'Fits YouTube\u2019s ~70-character display window without truncation.', confidence: 'high' });
  } else if (len < TITLE_MIN) {
    score += 5;
    findings.push({ component: 'title', level: 'warning', title: `Title is short (${len} chars)`, detail: 'Short titles waste search-relevant surface area.', recommendation: `Extend to ${TITLE_MIN}-${TITLE_MAX} characters, e.g. add a clarifying phrase or format label.`, expectedBenefit: 'More keyword coverage and clearer positioning.', confidence: 'high' });
  } else {
    score += 4;
    findings.push({ component: 'title', level: 'warning', title: `Title may be truncated (${len} chars)`, detail: 'YouTube truncates long titles in search and suggestions.', recommendation: 'Move the essential keyword phrase into the first ~60 characters.', confidence: 'high' });
  }

  // Keyword placement (max 10)
  if (input.keyword) {
    const pos = normalize(title).indexOf(normalize(input.keyword).split(' ')[0]);
    if (keywordIn(input.keyword, title) && pos >= 0 && pos <= 20) {
      score += 10;
      findings.push({ component: 'title', level: 'good', title: 'Keyword appears near the start', detail: `Target keyword appears at character ${pos}.`, confidence: 'high' });
    } else if (keywordIn(input.keyword, title)) {
      score += 6;
      findings.push({ component: 'title', level: 'warning', title: 'Keyword present but late', detail: 'Front-loading the keyword slightly helps both search and viewer scanning.', recommendation: 'Rewrite so the main keyword sits in the first few words.', expectedBenefit: 'Clearer topical signal.', confidence: 'medium' });
    } else {
      findings.push({ component: 'title', level: 'critical', title: 'Target keyword missing from title', detail: `Keyword "${input.keyword}" not found in title.`, recommendation: 'Include the main keyword naturally in the title.', expectedBenefit: 'Directly affects search relevance.', confidence: 'high' });
    }
  } else {
    score += 3;
    findings.push({ component: 'title', level: 'info', title: 'No target keyword set', detail: 'Run the analyzer with a target keyword to evaluate keyword placement.', confidence: 'high' });
  }

  // Clickbait hygiene / structure (max 5)
  const capsWords = title.split(/\s+/).filter((w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
  const excessiveCaps = capsWords.length > Math.max(2, title.split(/\s+/).length * 0.4);
  const clickbaitMarkers = /(you won'?t believe|gone wrong|shocking|insane!?|100%)\b/i;
  if (excessiveCaps) {
    findings.push({ component: 'title', level: 'warning', title: 'Heavy ALL-CAPS usage', detail: `${capsWords.length} words in full caps can read as spam.`, recommendation: 'Keep caps for at most one emphasis word.', confidence: 'medium' });
  } else {
    score += 3;
  }
  if (clickbaitMarkers.test(title)) {
    findings.push({ component: 'title', level: 'warning', title: 'Clickbait phrasing detected', detail: 'Phrases like "you won\u2019t believe" can depress long-term trust and CTR.', recommendation: 'Replace with a specific promise (number, outcome, timeframe).', confidence: 'low' });
  } else {
    score += 2;
  }

  return {
    component: 'title',
    score: Math.round((score / 25) * 100),
    weight: 30,
    explanation: 'Length fit, keyword placement, and spam-signal hygiene. Weight 30/100.',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

function scoreDescription(input: SeoScoreInput): SeoComponentScore {
  const findings: SeoFinding[] = [];
  let score = 0;
  const desc = input.description ?? '';
  const len = desc.trim().length;

  // Length (max 8)
  if (len >= DESC_MIN) {
    score += 8;
    findings.push({ component: 'description', level: 'good', title: `Description length is good (${len} chars)`, detail: 'Long enough for search engines to index meaningful content.', confidence: 'high' });
  } else if (len > 0) {
    score += Math.round((len / DESC_MIN) * 8);
    findings.push({ component: 'description', level: level(len / DESC_MIN), title: `Description is thin (${len} chars)`, detail: 'The first ~150 characters appear in search snippets; a fuller description adds indexable context.', recommendation: `Expand to at least ${DESC_MIN} characters: summary, chapter list, links, CTA.`, expectedBenefit: 'More keyword surface for search and suggested feeds.', confidence: 'high' });
  } else {
    findings.push({ component: 'description', level: 'critical', title: 'Description is empty', detail: 'No description to analyze.', recommendation: 'Write a 250+ character description starting with the main keyword.', confidence: 'high' });
  }

  // Keyword in first zone (max 7)
  if (input.keyword) {
    const first150 = desc.slice(0, DESC_FIRST_KEYWORD_ZONE);
    if (keywordIn(input.keyword, first150)) {
      score += 7;
      findings.push({ component: 'description', level: 'good', title: 'Keyword appears in the first 150 characters', detail: 'This zone is shown in search snippets and weighted most.', confidence: 'high' });
    } else if (keywordIn(input.keyword, desc)) {
      score += 3;
      findings.push({ component: 'description', level: 'warning', title: 'Keyword present but not in the first 150 characters', detail: 'Search snippets cut off around 150 characters.', recommendation: 'Move a sentence containing the keyword to the top.', confidence: 'high' });
    } else {
      findings.push({ component: 'description', level: 'critical', title: 'Target keyword missing from description', detail: `Keyword "${input.keyword}" not found.`, recommendation: 'Add 2-3 natural mentions, starting in the opening lines.', confidence: 'high' });
    }
  } else {
    score += 2;
  }

  // Structure: timestamps/chapters (max 4)
  const hasChapters = /(^|\n)\s*(0?0:00|\(0?0:00\))/m.test(desc) && (desc.match(/\d?\d:\d\d/g) ?? []).length >= 3;
  if (hasChapters) {
    score += 4;
    findings.push({ component: 'description', level: 'good', title: 'Chapters detected', detail: 'Timestamps improve navigation and can surface key moments in search.', confidence: 'high' });
  } else if (!input.isShort) {
    findings.push({ component: 'description', level: 'warning', title: 'No chapters/timestamps', detail: 'Long-form videos benefit from a chapter list (first timestamp must be 0:00).', recommendation: 'Add "0:00 Intro" style chapters covering each section.', expectedBenefit: 'Better viewer retention and key-moment search results.', confidence: 'medium' });
  } else {
    score += 3;
  }

  // Links + CTA (max 3)
  const hasLink = /https?:\/\//.test(desc);
  const hasCta = /(subscribe|follow|join|download|newsletter|comment below|watch next)/i.test(desc);
  if (hasLink) score += 1;
  if (hasCta) score += 1;
  if (!hasCta) {
    findings.push({ component: 'description', level: 'info', title: 'No clear call-to-action', detail: 'A CTA line ("Subscribe for weekly ...") lifts engagement slightly.', recommendation: 'Add one CTA sentence.', confidence: 'medium' });
  }

  // Hashtag hygiene (max 3)
  const hashtags = desc.match(/#\w+/g) ?? [];
  if (hashtags.length === 0) {
    findings.push({ component: 'description', level: 'info', title: 'No hashtags', detail: '1-3 relevant hashtags can help topical discovery.', recommendation: 'Add up to 3 relevant hashtags at the end.', confidence: 'low' });
  } else if (hashtags.length <= HASHTAG_LIMIT) {
    score += 3;
    findings.push({ component: 'description', level: 'good', title: `${hashtags.length} hashtag(s) - healthy amount`, detail: 'YouTube shows at most 3 hashtags above the title.', confidence: 'high' });
  } else {
    score += 1;
    findings.push({ component: 'description', level: 'warning', title: `Too many hashtags (${hashtags.length})`, detail: 'More than 15 hashtags void all hashtags; more than 3 dilute the visible ones.', recommendation: `Trim to ${HASHTAG_LIMIT} focused hashtags.`, confidence: 'high' });
  }

  return {
    component: 'description',
    score: Math.round((score / 25) * 100),
    weight: 25,
    explanation: 'Length, keyword position, chapters, CTA/links, hashtag hygiene. Weight 25/100.',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function scoreTags(input: SeoScoreInput): SeoComponentScore {
  const findings: SeoFinding[] = [];
  let score = 0;
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);

  if (tags.length === 0) {
    findings.push({ component: 'tags', level: 'warning', title: 'No tags found', detail: 'Tags contribute marginally to search but help with misspellings and variant discovery.', recommendation: 'Add 8-15 tags: main keyword first, then variants and topic words.', confidence: 'medium' });
  } else if (tags.length >= 8 && tags.length <= 30) {
    score += 8;
    findings.push({ component: 'tags', level: 'good', title: `${tags.length} tags - good coverage`, detail: 'Within the healthy 8-30 range.', confidence: 'medium' });
  } else if (tags.length < 8) {
    score += 4;
    findings.push({ component: 'tags', level: 'warning', title: `Few tags (${tags.length})`, detail: 'Add variant phrasings and sub-topics.', recommendation: 'Reach 8-15 tags.', confidence: 'medium' });
  } else {
    score += 5;
    findings.push({ component: 'tags', level: 'info', title: `Many tags (${tags.length})`, detail: 'Total tag characters are limited (~500); overly long lists can dilute relevance.', recommendation: 'Prioritize the 15 most relevant tags.', confidence: 'low' });
  }

  if (input.keyword) {
    const matches = tags.filter((t) => keywordIn(input.keyword!, t) || keywordIn(t, input.keyword!));
    if (matches.length > 0) {
      score += 7;
      findings.push({ component: 'tags', level: 'good', title: 'Keyword covered by tags', detail: `Matched tags: ${matches.slice(0, 5).join(', ')}`, confidence: 'medium' });
    } else {
      findings.push({ component: 'tags', level: 'warning', title: 'Target keyword not in tags', detail: 'Include the exact main keyword as the first tag.', confidence: 'medium' });
    }
  }

  return {
    component: 'tags',
    score: Math.min(100, Math.round((score / 15) * 100)),
    weight: 15,
    explanation: 'Tag count, coverage of the target keyword, and length hygiene. Weight 15/100.',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Keyword focus across metadata
// ---------------------------------------------------------------------------

function scoreKeywordFocus(input: SeoScoreInput): SeoComponentScore {
  const findings: SeoFinding[] = [];
  let score = 0;
  if (!input.keyword) {
    return {
      component: 'keywordFocus',
      score: 50,
      weight: 20,
      explanation: 'Consistency of the target keyword across title, description and tags. No keyword was provided, so a neutral 50 is reported.',
      findings: [{ component: 'keywordFocus', level: 'info', title: 'No target keyword set', detail: 'Provide a keyword to measure consistency across metadata.', confidence: 'high' }],
    };
  }

  const inTitle = keywordIn(input.keyword, input.title);
  const inDesc = keywordIn(input.keyword, input.description);
  const inTags = (input.tags ?? []).some((t) => keywordIn(input.keyword!, t) || keywordIn(t, input.keyword!));

  const hits = [inTitle, inDesc, inTags].filter(Boolean).length;
  score = (hits / 3) * 100;

  findings.push({
    component: 'keywordFocus',
    level: hits === 3 ? 'good' : hits === 2 ? 'warning' : 'critical',
    title: `Keyword appears in ${hits}/3 metadata surfaces`,
    detail: `Title: ${inTitle ? 'yes' : 'no'} | Description: ${inDesc ? 'yes' : 'no'} | Tags: ${inTags ? 'yes' : 'no'}.`,
    recommendation: hits === 3 ? undefined : 'Use the same core keyword in title, opening description lines, and first tag.',
    expectedBenefit: 'Consistent topical signal across surfaces.',
    confidence: 'high',
  });

  return {
    component: 'keywordFocus',
    score: Math.round(score),
    weight: 20,
    explanation: 'Consistency of the target keyword across title, description and tags. Weight 20/100.',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Overall
// ---------------------------------------------------------------------------

export function computeSeoScore(input: SeoScoreInput): SeoScoreResult {
  const components = [
    scoreTitle(input),
    scoreDescription(input),
    scoreTags(input),
    scoreKeywordFocus(input),
  ];
  const weightedSum = components.reduce((acc, c) => acc + (c.score * c.weight) / 100, 0);
  const overall = Math.round(weightedSum);
  const grade: SeoScoreResult['grade'] = overall >= 85 ? 'A' : overall >= 70 ? 'B' : overall >= 55 ? 'C' : overall >= 40 ? 'D' : 'F';

  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  const summary = weakest
    ? `Metadata scores ${overall}/100 (grade ${grade}). Biggest lever right now: ${weakest.component.replace(/([A-Z])/g, ' $1').toLowerCase()} at ${weakest.score}/100.`
    : `Metadata scores ${overall}/100 (grade ${grade}).`;

  return {
    overall,
    grade,
    components,
    summary,
    methodology:
      'Weighted transparent rubric: title 30 (length, keyword placement, hygiene), description 25 (length, keyword position, chapters, CTA, hashtags), tags 15, keyword consistency 20, plus public engagement benchmarks shown separately in audits. The score measures metadata quality only - it is NOT a prediction of views or ranking, and YouTube\u2019s ranking algorithm is not public.',
  };
}

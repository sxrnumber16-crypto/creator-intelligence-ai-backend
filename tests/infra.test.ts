import { beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret, decryptSecret, sha256, safeEqual } from '../src/lib/crypto.js';
import { extractVideoId } from '../src/services/seo/audit.js';
import { parseIsoDuration } from '../src/services/youtube/dataApi.js';
import { extractChannelInput } from '../src/services/competitors/tracker.js';
import { extractJson } from '../src/services/ai/types.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});

describe('crypto', () => {
  it('round-trips secrets with AES-256-GCM', () => {
    const secret = 'ya29.super-secret-google-token-value';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces different ciphertext per call (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects tampered payloads', () => {
    const encrypted = encryptSecret('data');
    const tampered = `${encrypted.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('hashes and compares safely', () => {
    expect(sha256('abc')).toHaveLength(64);
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
  });
});

describe('video id extraction', () => {
  it('parses every supported URL shape', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('not a video')).toBeNull();
  });
});

describe('ISO 8601 duration parsing', () => {
  it('parses hours, minutes and seconds', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT58S')).toBe(58);
    expect(parseIsoDuration('P1D')).toBe(0);
  });
});

describe('channel input parsing', () => {
  it('parses channel URLs, handles and raw IDs', () => {
    expect(extractChannelInput('https://www.youtube.com/channel/UC1234567890abcdefghijkl')).toEqual({ channelId: 'UC1234567890abcdefghijkl' });
    expect(extractChannelInput('https://www.youtube.com/@somecreator')).toEqual({ handle: '@somecreator' });
    expect(extractChannelInput('@somecreator')).toEqual({ handle: '@somecreator' });
    expect(extractChannelInput('UC1234567890abcdefghijkl')).toEqual({ channelId: 'UC1234567890abcdefghijkl' });
  });
});

describe('JSON extraction from model output', () => {
  it('handles fenced and plain JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

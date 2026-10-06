import { describe, it, expect } from 'vitest';
import { formatEtb, bingoLetter } from '../format';

describe('formatEtb', () => {
  it('formats whole ETB with the symbol', () => {
    expect(formatEtb(100)).toBe('100 ETB');
    expect(formatEtb(1500)).toBe('1,500 ETB');
  });
  it('does NOT divide (unlike the old BNB formatter)', () => {
    expect(formatEtb(5)).toBe('5 ETB');
    expect(formatEtb(10)).toBe('10 ETB');
  });
  it('handles null / undefined', () => {
    expect(formatEtb(null)).toBe('0 ETB');
    expect(formatEtb(undefined)).toBe('0 ETB');
  });
  it('symbol:false drops the suffix', () => {
    expect(formatEtb(42, { symbol: false })).toBe('42');
  });
  it('two decimals only when needed', () => {
    expect(formatEtb(12.5)).toBe('12.50 ETB');
  });
});

describe('bingoLetter', () => {
  it('maps ranges', () => {
    expect(bingoLetter(1)).toBe('B');
    expect(bingoLetter(30)).toBe('I');
    expect(bingoLetter(45)).toBe('N');
    expect(bingoLetter(60)).toBe('G');
    expect(bingoLetter(75)).toBe('O');
  });
});

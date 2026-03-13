import { describe, expect, it } from 'vitest';
import {
  UNIT_SCALE,
  agreementIdToUint256,
  scaleAmountToUint256,
  uint256ToAgreementId,
  uint256ToDecimalAmount,
  unitTypeToBytes32,
} from '../src/conversion';

describe('conversion utilities', () => {
  it('round-trips agreement IDs', () => {
    const value = agreementIdToUint256('12345678901234567890');
    expect(value).toBe(12345678901234567890n);
    expect(uint256ToAgreementId(value)).toBe('12345678901234567890');
  });

  it('rejects invalid agreement IDs', () => {
    expect(() => agreementIdToUint256('-1')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('1.5')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('abc')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('')).toThrowError('invalid_agreement_id');
  });

  it('scales decimal amounts to uint256 values', () => {
    expect(scaleAmountToUint256('1')).toBe(UNIT_SCALE);
    expect(scaleAmountToUint256('1.5')).toBe(1500000000000000000n);
    expect(scaleAmountToUint256('0.000000000000000001')).toBe(1n);
  });

  it('unscales uint256 values to decimal strings', () => {
    expect(uint256ToDecimalAmount(UNIT_SCALE)).toBe('1');
    expect(uint256ToDecimalAmount(1500000000000000000n)).toBe('1.5');
    expect(uint256ToDecimalAmount(1n)).toBe('0.000000000000000001');
  });

  it('rejects invalid decimal amounts', () => {
    expect(() => scaleAmountToUint256('0')).toThrowError('invalid_amount');
    expect(() => scaleAmountToUint256('-1')).toThrowError('invalid_amount');
    expect(() => scaleAmountToUint256('abc')).toThrowError('invalid_amount');
    expect(() => scaleAmountToUint256('1.1234567890123456789')).toThrowError('invalid_amount');
  });

  it('hashes unit types to bytes32', () => {
    const hashA = unitTypeToBytes32('VENICE_TEXT_TOKEN_IN');
    const hashB = unitTypeToBytes32('VENICE_TEXT_TOKEN_IN');
    const hashC = unitTypeToBytes32('VENICE_TEXT_TOKEN_OUT');

    expect(hashA).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });
});

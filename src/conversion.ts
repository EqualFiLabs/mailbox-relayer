import { keccak256, toUtf8Bytes } from 'ethers';

export const UNIT_SCALE = 10n ** 18n;
const UINT256_MAX = (1n << 256n) - 1n;

export function agreementIdToUint256(id: string): bigint {
  if (typeof id !== 'string') {
    throw new Error('invalid_agreement_id');
  }

  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('invalid_agreement_id');
  }

  const value = BigInt(trimmed);
  if (value > UINT256_MAX) {
    throw new Error('invalid_agreement_id');
  }

  return value;
}

export function uint256ToAgreementId(id: bigint): string {
  if (id < 0n || id > UINT256_MAX) {
    throw new Error('invalid_uint256');
  }

  return id.toString(10);
}

export function scaleAmountToUint256(decimalAmount: string): bigint {
  if (typeof decimalAmount !== 'string') {
    throw new Error('invalid_amount');
  }

  const trimmed = decimalAmount.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error('invalid_amount');
  }

  const intPart = BigInt(match[1]);
  const fracRaw = match[2] ?? '';
  if (fracRaw.length > 18) {
    throw new Error('invalid_amount');
  }

  const fracPart = fracRaw.length > 0 ? BigInt(fracRaw.padEnd(18, '0')) : 0n;
  const scaled = intPart * UNIT_SCALE + fracPart;

  if (scaled <= 0n) {
    throw new Error('invalid_amount');
  }
  if (scaled > UINT256_MAX) {
    throw new Error('amount_overflow');
  }

  return scaled;
}

export function uint256ToDecimalAmount(scaled: bigint): string {
  if (scaled < 0n || scaled > UINT256_MAX) {
    throw new Error('invalid_uint256');
  }

  const intPart = scaled / UNIT_SCALE;
  const fracPart = scaled % UNIT_SCALE;

  if (fracPart === 0n) {
    return intPart.toString(10);
  }

  const fracStr = fracPart.toString(10).padStart(18, '0').replace(/0+$/, '');
  return `${intPart.toString(10)}.${fracStr}`;
}

export function unitTypeToBytes32(unitType: string): string {
  if (typeof unitType !== 'string' || unitType.length === 0) {
    throw new Error('invalid_unit_type');
  }

  return keccak256(toUtf8Bytes(unitType));
}

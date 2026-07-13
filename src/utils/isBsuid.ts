const BSUID_REGEX = /^[A-Z]{2}(\.ENT)?\.[A-Za-z0-9]{1,128}$/;

export function isBsuid(value: string): boolean {
  return typeof value === 'string' && BSUID_REGEX.test(value);
}

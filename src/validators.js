'use strict';

/**
 * Shared input validation and normalisation helpers.
 *
 * Keeping these pure and dependency-free makes them trivial to unit test and
 * lets both the HTTP layer and the data layer agree on a single definition of
 * "valid".
 */

// E.164-style phone number: optional leading '+', then 7-15 digits.
const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

const PASSWORD_LENGTH = 8;

/**
 * Normalises a phone number to a canonical comparable form.
 * Strips spaces, dashes, parentheses and dots; preserves a single leading '+'.
 * Returns null when the input cannot be a valid phone number.
 */
function normalizePhone(rawPhone) {
  if (typeof rawPhone !== 'string') return null;
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  const candidate = (hasPlus ? '+' : '') + digits;

  return PHONE_REGEX.test(candidate) ? candidate : null;
}

/**
 * Validates a password. The product requires an 8 character password, so we
 * enforce a minimum length of 8 (longer is always allowed) and reject values
 * that are not strings.
 */
function validatePassword(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password is required.' };
  }
  if (password.length < PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${PASSWORD_LENGTH} characters long.`,
    };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password is too long.' };
  }
  return { ok: true };
}

/**
 * Trims and length-limits a free-text field. Returns the cleaned string.
 */
function cleanText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

module.exports = {
  PHONE_REGEX,
  PASSWORD_LENGTH,
  normalizePhone,
  validatePassword,
  cleanText,
};

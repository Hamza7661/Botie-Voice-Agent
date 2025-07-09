// getCountryInfoFromPhone.js
import { parsePhoneNumber } from 'libphonenumber-js';
import countryTimezone from 'country-timezone';

/**
 * Get country and timezone info from a phone number
 * @param {string} phoneNumberRaw - e.g. "+923001234567"
 * @returns {Object|null} - { countryCode, timezone } or null if invalid
 */
export function getCountryInfoFromPhone(phoneNumberRaw) {
  try {
    const phoneNumber = parsePhoneNumber(phoneNumberRaw);
    if (!phoneNumber || !phoneNumber.country) return null;

    const countryCode = phoneNumber.country;
    const timezones = countryTimezone.getTimezonesWithCountryCode(countryCode);

    return {
      countryCode,
      timezone: timezones?.[0] || null,
    };
  } catch (err) {
    console.error("❌ Error parsing phone number:", err.message);
    return null;
  }
}

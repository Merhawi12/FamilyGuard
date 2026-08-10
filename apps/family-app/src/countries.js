/**
 * Dialling codes for the country selector on the phone sign-in form.
 *
 * Not the full ITU list. A select with 240 entries is a worse control than one
 * with forty — it is slower to scroll on a phone, and every extra line is
 * between someone and the only two options they were ever going to pick. This is
 * the markets Parentix is sold in, plus the largest of everywhere else; anyone
 * outside it can still type a full `+…` number, which `normalizePhone` accepts.
 *
 * Canada leads because the product is Canadian and the apex is parentix.ca.
 *
 * `iso` is only a React key: +1 is shared by Canada and the US, so the dial code
 * alone is not unique and using it as the key silently drops one of them.
 */
export const COUNTRIES = [
  { iso: 'CA', name: 'Canada', dial: '+1', flag: '🇨🇦' },
  { iso: 'US', name: 'United States', dial: '+1', flag: '🇺🇸' },
  { iso: 'GB', name: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { iso: 'AU', name: 'Australia', dial: '+61', flag: '🇦🇺' },
  { iso: 'IE', name: 'Ireland', dial: '+353', flag: '🇮🇪' },
  { iso: 'NZ', name: 'New Zealand', dial: '+64', flag: '🇳🇿' },
  { iso: 'IN', name: 'India', dial: '+91', flag: '🇮🇳' },
  { iso: 'DE', name: 'Germany', dial: '+49', flag: '🇩🇪' },
  { iso: 'FR', name: 'France', dial: '+33', flag: '🇫🇷' },
  { iso: 'ES', name: 'Spain', dial: '+34', flag: '🇪🇸' },
  { iso: 'IT', name: 'Italy', dial: '+39', flag: '🇮🇹' },
  { iso: 'NL', name: 'Netherlands', dial: '+31', flag: '🇳🇱' },
  { iso: 'BE', name: 'Belgium', dial: '+32', flag: '🇧🇪' },
  { iso: 'CH', name: 'Switzerland', dial: '+41', flag: '🇨🇭' },
  { iso: 'AT', name: 'Austria', dial: '+43', flag: '🇦🇹' },
  { iso: 'SE', name: 'Sweden', dial: '+46', flag: '🇸🇪' },
  { iso: 'NO', name: 'Norway', dial: '+47', flag: '🇳🇴' },
  { iso: 'DK', name: 'Denmark', dial: '+45', flag: '🇩🇰' },
  { iso: 'FI', name: 'Finland', dial: '+358', flag: '🇫🇮' },
  { iso: 'PL', name: 'Poland', dial: '+48', flag: '🇵🇱' },
  { iso: 'PT', name: 'Portugal', dial: '+351', flag: '🇵🇹' },
  { iso: 'GR', name: 'Greece', dial: '+30', flag: '🇬🇷' },
  { iso: 'MX', name: 'Mexico', dial: '+52', flag: '🇲🇽' },
  { iso: 'BR', name: 'Brazil', dial: '+55', flag: '🇧🇷' },
  { iso: 'AR', name: 'Argentina', dial: '+54', flag: '🇦🇷' },
  { iso: 'ZA', name: 'South Africa', dial: '+27', flag: '🇿🇦' },
  { iso: 'NG', name: 'Nigeria', dial: '+234', flag: '🇳🇬' },
  { iso: 'KE', name: 'Kenya', dial: '+254', flag: '🇰🇪' },
  { iso: 'EG', name: 'Egypt', dial: '+20', flag: '🇪🇬' },
  { iso: 'ET', name: 'Ethiopia', dial: '+251', flag: '🇪🇹' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '+971', flag: '🇦🇪' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '+966', flag: '🇸🇦' },
  { iso: 'IL', name: 'Israel', dial: '+972', flag: '🇮🇱' },
  { iso: 'TR', name: 'Turkey', dial: '+90', flag: '🇹🇷' },
  { iso: 'JP', name: 'Japan', dial: '+81', flag: '🇯🇵' },
  { iso: 'KR', name: 'South Korea', dial: '+82', flag: '🇰🇷' },
  { iso: 'CN', name: 'China', dial: '+86', flag: '🇨🇳' },
  { iso: 'SG', name: 'Singapore', dial: '+65', flag: '🇸🇬' },
  { iso: 'MY', name: 'Malaysia', dial: '+60', flag: '🇲🇾' },
  { iso: 'PH', name: 'Philippines', dial: '+63', flag: '🇵🇭' },
  { iso: 'ID', name: 'Indonesia', dial: '+62', flag: '🇮🇩' },
  { iso: 'PK', name: 'Pakistan', dial: '+92', flag: '🇵🇰' },
  { iso: 'BD', name: 'Bangladesh', dial: '+880', flag: '🇧🇩' },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

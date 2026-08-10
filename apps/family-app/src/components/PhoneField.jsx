import { useId } from 'react';
import { COUNTRIES } from '../countries';

/**
 * A phone number, as a country selector joined to a national number.
 *
 * Split rather than one free-text box because the two halves have different
 * failure modes. The country code is a closed set and belongs in a control that
 * cannot be mistyped; the rest is digits the person knows by heart and will type
 * with whatever spacing they think in — `(415) 555-0123`, `415 555 0123` — all
 * of which `normalizePhone` on the server flattens to the same E.164 string.
 *
 * The value handed up is already joined, so callers never assemble it and can
 * never assemble it differently from one another.
 *
 * A native `<select>` on purpose: on a phone it opens the platform's own wheel,
 * which is faster to operate and more accessible than any listbox this could
 * reimplement, and it is keyboard-navigable and screen-reader-labelled for free.
 */
export default function PhoneField({
  label = 'Phone Number',
  country,
  onCountryChange,
  value,
  onChange,
  hint,
  ...props
}) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label}</label>

      {/* One bordered group so the two controls read as a single field. The
          inner controls drop their own borders and rings; the wrapper shows the
          focus state for whichever half has it, via focus-within. */}
      <div className="flex items-stretch w-full rounded-xl border border-gray-200 bg-white overflow-hidden
                      transition focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-100">
        <select
          value={country.iso}
          onChange={(e) => onCountryChange(COUNTRIES.find((c) => c.iso === e.target.value))}
          aria-label="Country calling code"
          className="shrink-0 min-h-[44px] pl-3 pr-1.5 text-base sm:text-sm text-gray-700 bg-gray-50
                     border-0 border-r border-gray-200 focus:outline-none cursor-pointer"
        >
          {COUNTRIES.map((c) => (
            // The flag is decorative next to the name, and the name is what a
            // screen reader should read — not an emoji whose announced text is
            // the country name again.
            <option key={c.iso} value={c.iso}>{`${c.flag} ${c.dial}`}</option>
          ))}
        </select>

        <input
          {...props}
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="555 000 1234"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? hintId : undefined}
          className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2.5 text-base sm:text-sm text-gray-900
                     bg-white placeholder:text-gray-400 border-0 focus:outline-none focus:ring-0"
        />
      </div>

      {hint && <p id={hintId} className="field-hint">{hint}</p>}
    </div>
  );
}

/** The E.164-ish string the API expects, assembled in exactly one place. */
export const joinPhone = (country, national) => `${country.dial}${national.replace(/\D/g, '')}`;

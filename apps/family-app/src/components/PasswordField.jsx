import { useState } from 'react';
import { Icon } from '@parentix/shared';

/**
 * A password input with a reveal control.
 *
 * Typing a password blind on a phone keyboard, with no autocorrect and no
 * visible characters, is the single most common reason a correct password gets
 * rejected. The button is inside the field's padding so the layout is identical
 * to a plain `.input`.
 */
export default function PasswordField({ label, className = '', ...props }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${className}`}>
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        aria-label={label}
        className="input pr-12"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center
                   rounded-lg text-gray-400 hover:text-gray-600 transition"
      >
        <Icon name={visible ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </div>
  );
}

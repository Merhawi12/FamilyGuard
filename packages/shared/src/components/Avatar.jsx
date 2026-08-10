const SIZES = {
  xs: 'w-7 h-7 text-xs',
  sm: 'w-9 h-9 text-sm',
  md: 'w-11 h-11 text-base',
  lg: 'w-16 h-16 text-2xl',
  xl: 'w-24 h-24 text-4xl',
};

/**
 * A child's photo when one has been uploaded, otherwise the first letter of
 * their name. `imageUrl` is always a URL the API issued and stored.
 */
export default function Avatar({ name = '', imageUrl, size = 'md', className = '' }) {
  const base = `${SIZES[size] || SIZES.md} rounded-full shrink-0 ${className}`;

  if (imageUrl) {
    return <img src={imageUrl} alt="" className={`${base} object-cover bg-gray-100`} />;
  }

  return (
    <div
      className={`${base} bg-primary-100 text-primary-700 font-semibold flex items-center justify-center select-none`}
    >
      {name.trim()[0]?.toUpperCase() || '?'}
    </div>
  );
}

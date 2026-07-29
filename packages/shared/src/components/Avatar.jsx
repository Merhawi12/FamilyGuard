const SIZES = {
  sm: 'w-8 h-8 text-sm',
  md: 'w-11 h-11 text-lg',
  lg: 'w-20 h-20 text-3xl',
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
    <div className={`${base} bg-blue-100 text-blue-600 font-bold flex items-center justify-center`}>
      {name.trim()[0]?.toUpperCase() || '?'}
    </div>
  );
}

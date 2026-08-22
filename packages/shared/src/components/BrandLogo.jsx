/**
 * The Parentix mark, in whichever format the browser can take.
 *
 * Both apps drew this as a bare `<img src="/logo.png">` in six places, and that
 * file is the 500×500 source mark the whole brand pipeline is generated from —
 * 82 kB of RGBA, served to a browser that draws it 36 to 80 px tall. It is not
 * badly compressed; the mark is anti-aliased over thousands of colours, so a
 * lossless re-encode comes out no smaller. WebP does: the same image is about
 * 25 kB, and it is the single largest asset on the sign-in screen.
 *
 * The PNG is kept as the `<img>` fallback rather than dropped, so a browser with
 * no WebP decoder still gets a logo instead of a broken image. `logo.webp` is
 * generated from `logo.png` by scripts/build-brand-assets.mjs, so the two cannot
 * drift; `npm run assets:check` fails if they have.
 *
 * ── Why `display: contents` ──────────────────────────────────────────────────
 *
 * A `<picture>` is an inline box wrapped around the `<img>`, and every call site
 * lays the image out with utility classes that assume the image *is* the child —
 * `mx-auto` to centre it, `shrink-0` inside a flex row. Those stop working
 * through an inline wrapper: `margin: auto` on an inline element centres
 * nothing, and the flex parent starts sizing the `<picture>` instead. Removing
 * the wrapper's own box puts the `<img>` back into the parent's layout exactly
 * where it was, so this swap is invisible to every stylesheet that already
 * exists.
 */
export default function BrandLogo({ className = '', alt = 'Parentix', ...rest }) {
  return (
    <picture style={{ display: 'contents' }}>
      <source srcSet="/logo.webp" type="image/webp" />
      <img src="/logo.png" alt={alt} className={className} {...rest} />
    </picture>
  );
}

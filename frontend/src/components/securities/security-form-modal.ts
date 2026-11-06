/**
 * The width and padding of every modal that hosts `SecurityForm`, spread onto
 * `Modal` so New Security opened from a transaction's Security picker, the
 * Securities page, a security's detail page and the strategy settings is the
 * same dialog. The form puts its fields two to a row at this width. Literal
 * class strings, so Tailwind sees them; a module of its own, so a host's test
 * that mocks the form still gets the real width.
 */
export const securityFormModalProps = {
  maxWidth: '3xl',
  className: 'p-6',
} as const;

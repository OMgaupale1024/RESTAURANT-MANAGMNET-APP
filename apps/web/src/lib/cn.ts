/** Join class fragments, dropping falsy ones. All the classnames lib we need. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

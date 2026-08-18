/** Firefox は browser/chrome 両方を持つ。browser を優先すると両ブラウザで Promise API に揃う。 */
export const ext = globalThis.browser ?? globalThis.chrome;

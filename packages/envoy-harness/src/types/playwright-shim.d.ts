/**
 * Ambient shim so typecheck succeeds when the optional `playwright`
 * peer dependency is not installed. Runtime still dynamic-imports the
 * real package.
 */
declare module "playwright" {
  const playwright: unknown;
  export default playwright;
}

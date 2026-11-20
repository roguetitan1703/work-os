// The public keys that sign worker releases (docs/launcher.md "Self-update"). A downloaded worker installs a new version
// only when one of the keys listed in its own running copy signed it, so this list changes only through a signed update.
// Each entry: an Ed25519 public key, base64 of its SPKI DER form. `node scripts/worker-signing-key.mjs new` adds one.
// The private key never comes near the repo or the server: it stays on Om's PC, under DPAPI for his Windows account.
export const RELEASE_KEYS = [
];

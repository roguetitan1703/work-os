// The public keys that sign worker releases (docs/ops/launcher.md "Self-update"). A downloaded worker installs a new version
// only when one of the keys listed in its own running copy signed it, so this list changes only through a signed update.
// Each entry: an Ed25519 public key, base64 of its SPKI DER form. `node scripts/worker-signing-key.mjs new` adds one.
// The private key never comes near the repo or the server: it stays on Om's PC, under DPAPI for his Windows account.
export const RELEASE_KEYS = [
  'MCowBQYDK2VwAyEAp0AN3om5rlcn07MnzPXO6wZkPt7dGqFSeL4Q+4XWrAM=', // Oms PC, 20 Nov 2026, made 2026-11-20
];

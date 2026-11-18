# End-to-end encryption review and ratchet evaluation

Scope: `client/src/crypto.js` (browser crypto), `server/routes-chat.js` (envelope storage).
This is a factual review of what the code does today, followed by the ratchet evaluation
the Founder asked for. Nothing here claims a capability the code does not have.

## What is actually implemented

- **Identity key.** Each device generates a **non-extractable ECDH P-256** key pair on
  first use and keeps it in IndexedDB (`ensureIdentity`). The private key never leaves the
  browser in usable form and cannot be exported.
- **Public key publication.** The device publishes its public JWK to
  `PUT /api/users/me/public-key` (accepts `publicKey` or `publicKeyJwk`).
- **Message key.** `ECDH(myPrivateKey, peerPublicKey)` → **HKDF-SHA256** (per-message
  random salt, info string `#ash-mesh/dm/v1`) → **AES-256-GCM** key.
- **Envelope.** `{ v, iv, ct, salt, pub }`, where `pub` is the sender's public JWK.
- **Server blindness.** The server stores the envelope as an opaque string
  (`messages.envelope`). `POST` rejects anything that is not a well-formed envelope, so
  plaintext cannot be stored by accident. Private message content is not readable by the
  server, and #ash AI is never given message ciphertext keys.
- **Files.** Media is encrypted client-side with a fresh AES-GCM key before upload; the
  key travels inside the message envelope, not in a server-side column.
- **Offline storage.** Queued messages are kept as envelopes, so the local database does
  not hold plaintext either.

## Weaknesses found in this review (real, not hypothetical)

1. **No forward secrecy.** The message key is derived from a *static* device key pair.
   Anyone who obtains a device's private key — or a future export of it — can derive keys
   for every past message of that device. There is no ratchet, no per-message ephemeral
   key, no chain-key advance.
2. **No sender authentication.** `decryptFromPeer` imports `envelope.pub` as supplied and
   derives the key from it. A recipient therefore cannot tell whether the message really
   came from the account it claims to come from. A compromised or malicious relay can
   construct a valid envelope with its own key pair and present it as another user's
   message. Confidentiality against the server holds; *authenticity* does not.
3. **No associated-data binding.** The AES-GCM call passes no `additionalData`, so the
   ciphertext is not cryptographically bound to its conversation, sender or message id.
   A ciphertext that decrypts correctly can be relocated into another conversation
   context by a relay without detection (it still cannot be read, but the context is
   forgeable).
4. **No safety number / key verification UI.** Users cannot compare fingerprints, so key
   substitution is undetectable by the people using the app.
5. **No key rotation.** A device keeps one identity key for its lifetime.

These are documented rather than papered over. The existing scheme is honest static ECDH
plus authenticated encryption; it is **not** the Signal Protocol and must not be described
as such.

## Ratchet evaluation

| Option | Forward secrecy | Sender auth | Cost / risk |
| --- | --- | --- | --- |
| Keep static ECDH (today) | No | No | Zero migration risk, but weaknesses 1–4 remain |
| **v2 envelope: ephemeral ECDH per message + Ed25519 signature + AAD** | Partial (past messages safe once the ephemeral key is deleted; identity key still long-lived) | Yes, once signatures are verified against the published identity key | Medium: new envelope version, key management for signing keys, migration must keep v1 decryption |
| **Full Double Ratchet (X3DH + Double Ratchet, e.g. libsignal)** | Yes | Yes, with safety numbers | High: prekey bundles, session state per conversation, multi-device, message ordering under offline queue, substantial test surface |

**Recommendation.** Move to the v2 envelope in a dedicated stage: versioned envelopes
(`v: 2`), an ephemeral key per message, an Ed25519 signature over the ciphertext plus
conversation/sender ids as AAD, published safety numbers, and v1 kept for decryption of
history. The full Double Ratchet is the correct end state but needs a dedicated migration
stage because the offline outbox, multi-device use and message ordering all interact with
session state.

**Why this was not done inside Stage F:** it changes the on-the-wire format for every
private message. Doing it as a drive-by change in a hardening pass — without its own
migration and regression suite — would risk silently breaking existing conversations,
which the standing rules forbid.

## Preserved guarantees (unchanged by Stage F)

- The server never receives plaintext private messages.
- #ash AI never receives private message content unless the user explicitly pastes it.
- Envelope validation still rejects plaintext and oversized payloads.
- Existing stored envelopes remain decryptable; no key format was changed in this stage.

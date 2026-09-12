/**
 * The browser half of Termly's end-to-end encryption.
 *
 * Web Crypto has no finite-field Diffie-Hellman - only ECDH - so the modp14
 * exchange the CLI uses is done here with BigInt. Everything after that (HKDF,
 * AES-GCM) is native.
 */

// RFC 3526 group 14, the same 2048-bit group as crypto.getDiffieHellman('modp14').
const MODP14_PRIME_HEX =
  'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74' +
  '020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437' +
  '4fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed' +
  'ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf05' +
  '98da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb' +
  '9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b' +
  'e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf695581718' +
  '3995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff';

const P = BigInt('0x' + MODP14_PRIME_HEX);
const G = 2n;

// Node's computeSecret() zero-pads to the prime width (DH_compute_key_padded),
// so the browser must pad too. This is not cosmetic: roughly one exchange in
// 256 yields a secret with a leading zero byte, and an unpadded copy would feed
// HKDF a different input and derive a different AES key.
const SECRET_BYTES = 256;

function bigIntToBytes(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function padTo(bytes, length) {
  if (bytes.length >= length) return bytes;
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

function bytesToBigInt(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
}

// Right-to-left square and multiply. A 256-bit exponent keeps this well under a
// second on a phone while giving the ~128-bit security the group allows.
function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function generateKeyPair() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = bytesToBigInt(priv);
  const publicKey = modPow(G, privateKey, P);

  return {
    privateKey,
    // The public value is padded to the modulus width, which is what every DH
    // implementation expects to receive.
    publicKey: bytesToBase64(padTo(bigIntToBytes(publicKey), SECRET_BYTES))
  };
}

// A resumed session has to reuse the exact private exponent it paired with:
// the CLI still holds the key derived from the matching public value, and a new
// exponent would silently produce a different AES key.
export function exportPrivateKey(privateKey) {
  return bytesToBase64(padTo(bigIntToBytes(privateKey), 32));
}

export function importPrivateKey(base64) {
  const value = bytesToBigInt(base64ToBytes(base64));
  if (value <= 1n) throw new Error('Invalid stored private key');
  return value;
}

export function derivePublicKey(privateKey) {
  return bytesToBase64(padTo(bigIntToBytes(modPow(G, privateKey, P)), SECRET_BYTES));
}

export function computeSharedSecret(privateKey, theirPublicKeyBase64) {
  const theirPublic = bytesToBigInt(base64ToBytes(theirPublicKeyBase64));

  // Reject the degenerate values that would collapse the secret to a constant.
  if (theirPublic <= 1n || theirPublic >= P - 1n) {
    throw new Error('Invalid peer public key');
  }

  return padTo(bigIntToBytes(modPow(theirPublic, privateKey, P)), SECRET_BYTES);
}

// Must match lib/crypto/dh.js: HKDF-SHA256, empty salt, info "termly-session-key".
export async function deriveAESKey(sharedSecret) {
  const ikm = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('termly-session-key')
    },
    ikm,
    256
  );

  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// The CLI appends the 16-byte auth tag to the ciphertext, which is exactly what
// Web Crypto produces and consumes.
export async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data);

  return {
    data: bytesToBase64(new Uint8Array(sealed)),
    iv: bytesToBase64(iv)
  };
}

export async function decrypt(dataBase64, ivBase64, key) {
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivBase64), tagLength: 128 },
    key,
    base64ToBytes(dataBase64)
  );

  return new TextDecoder().decode(opened);
}

export async function fingerprint(publicKeyBase64) {
  const hash = await crypto.subtle.digest('SHA-256', base64ToBytes(publicKeyBase64));
  return Array.from(new Uint8Array(hash))
    .slice(0, 12)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

/**
 * Proves the browser crypto module and the CLI's node:crypto agree byte for
 * byte. If this fails, the phone and the terminal derive different AES keys and
 * the session dies with "no encryption key set" - so nothing gets built on top
 * of it until this passes.
 */
import crypto from 'node:crypto';
import {
  generateKeyPair, computeSharedSecret, deriveAESKey,
  encrypt, decrypt, bytesToBase64, base64ToBytes
} from '../public/termly-crypto.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' - ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// --- 1. Same group -----------------------------------------------------------
const node = crypto.getDiffieHellman('modp14');
node.generateKeys();
const nodePrime = node.getPrime('hex');
const source = await (await import('node:fs/promises'))
  .readFile(new URL('../public/termly-crypto.js', import.meta.url), 'utf8');
const primeFromModule = Buffer.from(
  source.match(/MODP14_PRIME_HEX =\n([\s\S]*?);/)[1].replace(/[^0-9a-f]/g, ''), 'hex'
).toString('hex');
check('modp14 prime matches Node', primeFromModule === nodePrime);
check('generator is 2', node.getGenerator('hex').replace(/^0+/, '') === '2');

// --- 2. Shared secret agreement, both directions ------------------------------
// 300 rounds so the ~1-in-256 leading-zero secret is actually exercised.
let mismatches = 0, zeroLeadSeen = 0, shortSeen = 0;
for (let i = 0; i < 300; i++) {
  const cli = crypto.getDiffieHellman('modp14');
  cli.generateKeys();
  const cliPub = cli.getPublicKey().toString('base64');

  const web = generateKeyPair();

  const webSecret = computeSharedSecret(web.privateKey, cliPub);
  const cliSecret = cli.computeSecret(Buffer.from(web.publicKey, 'base64'));

  if (Buffer.compare(Buffer.from(webSecret), cliSecret) !== 0) mismatches++;
  if (cliSecret.length < 256) { shortSeen++; zeroLeadSeen++; }
}
check('shared secret matches node computeSecret (300 rounds)', mismatches === 0,
  `${mismatches} mismatches`);

// The leading-zero secret is the case that actually broke: Node zero-pads to the
// prime width, so an unpadded browser secret silently derives a different key.
// Hunt one down rather than hoping the random loop above happened to hit it.
let zeroLeadTested = 0, zeroLeadOk = 0;
for (let i = 0; i < 5000 && zeroLeadTested < 3; i++) {
  const peer = crypto.getDiffieHellman('modp14');
  peer.generateKeys();
  const mine = generateKeyPair();
  const secret = computeSharedSecret(mine.privateKey, peer.getPublicKey().toString('base64'));
  if (secret[0] !== 0) continue;
  zeroLeadTested++;
  const theirs = peer.computeSecret(Buffer.from(mine.publicKey, 'base64'));
  if (Buffer.compare(Buffer.from(secret), theirs) === 0) zeroLeadOk++;
}
check('leading-zero shared secret stays padded', zeroLeadTested > 0 && zeroLeadOk === zeroLeadTested,
  `${zeroLeadOk}/${zeroLeadTested} leading-zero cases found and matched`);

// --- 3. HKDF ------------------------------------------------------------------
const cli = crypto.getDiffieHellman('modp14');
cli.generateKeys();
const web = generateKeyPair();
const shared = computeSharedSecret(web.privateKey, cli.getPublicKey().toString('base64'));
const sharedNode = cli.computeSecret(Buffer.from(web.publicKey, 'base64'));

const nodeKey = Buffer.from(crypto.hkdfSync('sha256', sharedNode, '', 'termly-session-key', 32));
const webKeyObj = await deriveAESKey(shared);
const webKeyRaw = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw',
  await crypto.webcrypto.subtle.importKey('raw',
    Buffer.from(await (async () => {
      const ikm = await crypto.webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      return crypto.webcrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
          info: new TextEncoder().encode('termly-session-key') }, ikm, 256);
    })()),
    { name: 'AES-GCM' }, true, ['encrypt'])));
check('HKDF-SHA256 empty salt matches node hkdfSync',
  Buffer.compare(nodeKey, webKeyRaw) === 0, nodeKey.toString('hex').slice(0, 16) + '...');

// --- 4. AES-256-GCM both ways -------------------------------------------------
// Browser encrypts -> CLI decrypts.
const plaintext = 'ls -la /home\nš ľ č ť ž 🔐\r';
const sealed = await encrypt(plaintext, webKeyObj);
const raw = Buffer.from(sealed.data, 'base64');
const decipher = crypto.createDecipheriv('aes-256-gcm', nodeKey, Buffer.from(sealed.iv, 'base64'));
decipher.setAuthTag(raw.subarray(raw.length - 16));
const opened = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
check('browser encrypt -> node decrypt', opened === plaintext);

// CLI encrypts -> browser decrypts, in the CLI's exact format (tag appended).
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', nodeKey, iv);
const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const packed = Buffer.concat([body, cipher.getAuthTag()]).toString('base64');
const roundTrip = await decrypt(packed, iv.toString('base64'), webKeyObj);
check('node encrypt -> browser decrypt', roundTrip === plaintext);

// --- 5. Tampering must fail ----------------------------------------------------
const tampered = Buffer.from(packed, 'base64');
tampered[0] ^= 0xff;
let rejected = false;
try { await decrypt(tampered.toString('base64'), iv.toString('base64'), webKeyObj); }
catch { rejected = true; }
check('tampered ciphertext rejected', rejected);

// --- 6. Degenerate peer keys rejected -------------------------------------------
let guarded = 0;
for (const bad of [Buffer.from([1]), Buffer.from([0]), cli.getPrime()]) {
  try { computeSharedSecret(web.privateKey, bad.toString('base64')); }
  catch { guarded++; }
}
check('degenerate peer public keys rejected', guarded === 3, `${guarded}/3`);

// --- 7. Public key is full modulus width ----------------------------------------
let widths = new Set();
for (let i = 0; i < 20; i++) widths.add(base64ToBytes(generateKeyPair().publicKey).length);
check('public key always 256 bytes', widths.size === 1 && widths.has(256), [...widths].join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

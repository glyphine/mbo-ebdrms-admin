import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const version = 'scrypt-v1';
const options = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const dummySalt = randomBytes(16);
const dummyHash = Buffer.alloc(32);
export const maxPasswordLength = 256;

function validLength(password: string) {
  return !!password && Buffer.byteLength(password) <= 1024 && [...password].length <= maxPasswordLength;
}

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, options, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

// For trusted account provisioning. The password is never trimmed or logged.
export async function hashPassword(password: string) {
  if (!validLength(password)) throw new Error('Invalid password length');
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `${version}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string | undefined) {
  if (!validLength(password)) return false;
  const [prefix, saltHex, hashHex, extra] = encoded?.split(':', 4) ?? [];
  const supported = prefix === version && extra === undefined &&
    saltHex?.length === 32 && !/[^0-9a-f]/.test(saltHex) &&
    hashHex?.length === 64 && !/[^0-9a-f]/.test(hashHex);
  const salt = supported ? Buffer.from(saltHex, 'hex') : dummySalt;
  const expected = supported ? Buffer.from(hashHex, 'hex') : dummyHash;
  const matches = timingSafeEqual(await derive(password, salt), expected);
  return supported && matches;
}

'use strict';

const crypto = require('crypto');

/**
 * Build-time pin set: SHA-256 hashes of the Subject Public Key Info (SPKI)
 * for the Backend API's leaf and/or intermediate certificates.
 *
 * Format: base64-encoded SHA-256 digests (RFC 7469 style).
 * Replace these with actual pin values before shipping a production build.
 *
 * To extract a pin from a certificate PEM:
 *   openssl x509 -in cert.pem -pubkey -noout | \
 *     openssl pkey -pubin -outform DER | \
 *     openssl dgst -sha256 -binary | base64
 */
const PINNED_HASHES = [
  // Leaf certificate SPKI SHA-256 (placeholder — replace at build time)
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  // Intermediate certificate SPKI SHA-256 (placeholder — replace at build time)
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
];

/**
 * Computes the SHA-256 hash of the SPKI (Subject Public Key Info) from a
 * DER-encoded certificate buffer.
 *
 * The SPKI is extracted by parsing the certificate's public key using
 * Node.js crypto. Electron provides the raw DER data for each certificate
 * in the chain via the `certificate` object's `data` property.
 *
 * @param {Buffer} derCert - DER-encoded X.509 certificate
 * @returns {string} Base64-encoded SHA-256 hash of the SPKI
 */
function computeSpkiHash(derCert) {
  // Create an X509Certificate object from the DER buffer
  const x509 = new crypto.X509Certificate(derCert);
  // publicKey exports the SPKI in DER format
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64');
  return hash;
}

/**
 * Checks whether any certificate in the provided chain matches a pinned hash.
 *
 * @param {Array<Buffer>} certChainDerBuffers - Array of DER-encoded certificate buffers
 *   (leaf first, then intermediates, then root)
 * @returns {{ match: boolean, matchedHash: string|null }}
 */
function matchesPinSet(certChainDerBuffers) {
  for (const derBuf of certChainDerBuffers) {
    try {
      const hash = computeSpkiHash(derBuf);
      if (PINNED_HASHES.includes(hash)) {
        return { match: true, matchedHash: hash };
      }
    } catch (_err) {
      // Skip certificates that cannot be parsed (e.g. malformed)
      continue;
    }
  }
  return { match: false, matchedHash: null };
}

/**
 * Installs a certificate verification procedure on the given Electron session
 * that enforces SPKI SHA-256 pinning for connections to the Backend API.
 *
 * When none of the certificates in the presented chain match the pin set,
 * the connection is aborted before any request payload is written and a
 * connection-failure indication is surfaced via the callback.
 *
 * @param {Electron.Session} electronSession - The Electron session to install
 *   the certificate verify proc on (typically `session.defaultSession`)
 * @param {object} [options] - Optional configuration
 * @param {string[]} [options.pins] - Override pin set (useful for testing)
 * @param {function} [options.onPinFailure] - Callback invoked on pin mismatch
 *   with `{ hostname, verificationResult }`. Use to surface UI indication.
 * @returns {void}
 */
function installCertificatePinner(electronSession, options = {}) {
  const pins = options.pins || PINNED_HASHES;
  const onPinFailure = options.onPinFailure || null;

  electronSession.setCertificateVerifyProc((request, callback) => {
    const { hostname, certificate, verificationResult } = request;

    // If the OS/Chromium already rejected the cert (e.g. expired, revoked),
    // honour that rejection regardless of pinning.
    if (verificationResult !== 'net::OK' && verificationResult !== 0) {
      if (onPinFailure) {
        onPinFailure({ hostname, verificationResult, reason: 'os_rejected' });
      }
      // -2 = CERT_AUTHORITY_INVALID — abort connection
      callback(-2);
      return;
    }

    // Build the certificate chain as DER buffers.
    // Electron's certificate object provides `data` (PEM string) for the leaf
    // and `issuerCert` chain for intermediates.
    const chainDerBuffers = [];

    try {
      // Collect leaf and all intermediates from the chain
      let current = certificate;
      while (current) {
        if (current.data) {
          // certificate.data is a PEM-encoded string in Electron
          const derBuf = pemToDer(current.data);
          if (derBuf) {
            chainDerBuffers.push(derBuf);
          }
        }
        // Walk up the issuer chain
        current = current.issuerCert || null;
        // Prevent infinite loops (self-signed root references itself)
        if (current && current === certificate) break;
      }
    } catch (_err) {
      // If we can't parse the chain at all, reject for safety
      if (onPinFailure) {
        onPinFailure({ hostname, verificationResult, reason: 'chain_parse_error' });
      }
      callback(-2);
      return;
    }

    if (chainDerBuffers.length === 0) {
      // No parseable certificates — reject
      if (onPinFailure) {
        onPinFailure({ hostname, verificationResult, reason: 'empty_chain' });
      }
      callback(-2);
      return;
    }

    // Check each cert in the chain against the pin set
    for (const derBuf of chainDerBuffers) {
      try {
        const hash = computeSpkiHash(derBuf);
        if (pins.includes(hash)) {
          // Pin matched — allow the connection
          callback(0);
          return;
        }
      } catch (_err) {
        // Skip unparseable certs, continue checking others
        continue;
      }
    }

    // No certificate in the chain matched any pin — abort connection
    if (onPinFailure) {
      onPinFailure({ hostname, verificationResult, reason: 'pin_mismatch' });
    }
    // -2 = reject the certificate, aborting the TLS handshake
    // This ensures no request payload is written over the connection.
    callback(-2);
  });
}

/**
 * Converts a PEM-encoded certificate string to a DER Buffer.
 *
 * @param {string} pem - PEM-encoded certificate
 * @returns {Buffer|null} DER-encoded certificate buffer, or null if parsing fails
 */
function pemToDer(pem) {
  try {
    // Strip PEM headers/footers and decode base64
    const lines = pem.split('\n');
    const base64Lines = lines.filter(
      (line) => !line.startsWith('-----') && line.trim().length > 0
    );
    const base64Str = base64Lines.join('');
    return Buffer.from(base64Str, 'base64');
  } catch (_err) {
    return null;
  }
}

/**
 * Removes the installed certificate verify proc, restoring default behavior.
 *
 * @param {Electron.Session} electronSession - The Electron session
 */
function removeCertificatePinner(electronSession) {
  electronSession.setCertificateVerifyProc(null);
}

module.exports = {
  installCertificatePinner,
  removeCertificatePinner,
  // Exported for testing
  computeSpkiHash,
  matchesPinSet,
  pemToDer,
  PINNED_HASHES
};

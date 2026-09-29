import type { NextConfig } from "next";

/**
 * Security headers — applied to every route (pages + API).
 *
 * CSP notes:
 * - 'unsafe-eval' + 'unsafe-inline' on script-src are required by the Next.js
 *   dev runtime (react-refresh / bootstrap inline scripts). This still blocks
 *   all third-party script origins, plugin media and framing.
 * - Google Fonts (fonts.googleapis.com / fonts.gstatic.com) are the only
 *   third-party origins allowed — they serve the brand typography.
 * - connect-src 'self' covers same-origin API calls and the gateway WebSocket.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  // Clickjacking: the app must never be framed (belt to CSP frame-ancestors braces)
  { key: "X-Frame-Options", value: "DENY" },
  // Stop MIME-type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak full URLs to third parties
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No sensitive browser APIs
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Force HTTPS for 2 years once served over TLS (gateway terminates SSL)
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Cross-origin writes are never useful here
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

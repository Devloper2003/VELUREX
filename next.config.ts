import type { NextConfig } from "next";

/**
 * Security headers — applied to every route (pages + API).
 *
 * CSP notes:
 * - 'unsafe-eval' + 'unsafe-inline' on script-src are required by the Next.js
 *   dev runtime (react-refresh / bootstrap inline scripts). Other third-party
 *   script origins, plugin media and framing stay blocked.
 * - Google Fonts (fonts.googleapis.com / fonts.gstatic.com) are the only other
 *   third-party origins allowed — they serve the brand typography.
 * - Razorpay hosted checkout needs explicit allowances: the checkout script
 *   (checkout.razorpay.com/v1/checkout.js), its payment modal iframe
 *   (api.razorpay.com / checkout.razorpay.com), its in-page XHR + telemetry
 *   endpoints and badge images. Without these the modal can never open
 *   ("Could not load the payment window").
 * - connect-src 'self' covers same-origin API calls and the gateway WebSocket.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.razorpay.com https://razorpay.com",
  "connect-src 'self' https://*.razorpay.com",
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
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
  // No sensitive browser APIs (the payment API is allowed for Razorpay's
  // hosted checkout iframe, which runs the Payment Request flow)
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self \"https://checkout.razorpay.com\"), usb=()" },
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

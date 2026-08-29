import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tesseract.js spawns a Node worker by resolving a path inside its own package. Bundling
  // rewrites that path to "/ROOT/node_modules/tesseract.js/src/worker-script/node/index.js",
  // which does not exist, and the spawn failure surfaces as an uncaughtException from the
  // worker rather than a rejected promise — so the OCR stage hung for the full request
  // budget instead of failing. Left external, Next resolves it with a native require and the
  // worker path is correct. Found by running a real .pptx through the real route; no unit
  // test could have seen it, because the bundler is not involved outside the app.
  serverExternalPackages: ['tesseract.js'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              // fonts.googleapis.com serves the stylesheet the landing page @imports
              // (Caveat, Playfair Display, DM Sans — app/globals.css line 2). Without it
              // the CSP blocks the import silently and the whole landing page falls back
              // to system fonts, which is most of what the design is.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              // api.dicebear.com serves every participant avatar (lib/avatars.ts). Without it
              // here the leaderboard, podium and host roster render broken images.
              "img-src 'self' data: blob: https://api.dicebear.com",
              // The stylesheet above resolves its actual font files from gstatic. Allowing
              // googleapis without gstatic loads the @font-face rules and then blocks every
              // file they point at — the same fallback, one step later.
              "font-src 'self' data: https://fonts.gstatic.com",
              // wss:// is listed explicitly. Supabase Realtime connects over a WebSocket, and
              // Chrome does not accept it under the https:// source expression alone, so
              // without this every live room silently fails to subscribe.
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

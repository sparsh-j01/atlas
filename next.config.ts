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
    const isProd = process.env.NODE_ENV === 'production'

    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // 'unsafe-eval' is Turbopack's dev refresh runtime and nothing else — the
              // production bundle never calls eval, so it is dropped there.
              //
              // 'unsafe-inline' stays, deliberately. The nonce alternative requires every
              // page to be dynamically rendered (next/dist/docs → content-security-policy:
              // "Static pages are generated at build time, when no request or response
              // headers exist"), which would cost the landing and pricing pages their static
              // generation to harden a route that holds no secret. What backs that trade is
              // that script access is no longer worth much here: the session cookie is
              // httpOnly (lib/supabase/cookie-options.ts) and no token is reachable from JS.
              `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
              "style-src 'self' 'unsafe-inline'",
              // api.dicebear.com serves every participant avatar (lib/avatars.ts). Without it
              // here the leaderboard, podium and host roster render broken images.
              "img-src 'self' data: blob: https://api.dicebear.com",
              // Caveat, Playfair Display and DM Sans are self-hosted by next/font (see
              // app/layout.tsx), so no third-party font origin is needed. They were loaded
              // over an @import from fonts.googleapis.com until the design pass; keep them
              // self-hosted and this stays closed.
              "font-src 'self' data:",
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
          // Safe here only because social sign-in is a full-page redirect. A popup-based
          // OAuth flow needs window.opener and would break under same-origin.
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          // Production only. On http://localhost this would pin EVERY localhost port in the
          // developer's browser to https for two years, including other projects.
          ...(isProd
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=31536000; includeSubDomains',
                },
              ]
            : []),
        ],
      },
      {
        // Nothing under these paths is cacheable by anyone: they carry a session, a
        // participant's own score, or a one-time auth redirect. A cached redirect for an
        // already-consumed code is the specific failure this prevents.
        source: '/:path(api|auth)/:rest*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/:path(login|reset-password)',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;

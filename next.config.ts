// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The commit this bundle was built from, baked into the client so a page can tell when the server behind it has
  // been redeployed. A Jev tab left open across a deploy once ran old pipeline code against a new server and
  // skipped every contact lookup without saying why.
  env: { NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? "local" },
};

export default nextConfig;

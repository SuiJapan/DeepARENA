/** @type {import("next").NextConfig} */
const nextConfig = {
    outputFileTracingExcludes: {
        "next-server": ["**/next/dist/server/capsize-font-metrics.json"],
    },
    turbopack: {
        root: require("node:path").dirname(__dirname),
    },
};

module.exports = nextConfig;

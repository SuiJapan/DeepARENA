/** @type {import("next").NextConfig} */
const nextConfig = {
    turbopack: {
        root: require("node:path").dirname(__dirname),
    },
};

module.exports = nextConfig;

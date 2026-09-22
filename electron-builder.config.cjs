const { build } = require('./package.json')
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const notarized = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
if (process.platform === 'darwin' && process.env.AI_OLD_REQUIRE_NOTARIZATION === 'true' && (!signed || !notarized)) {
  throw new Error('Developer ID and Apple notarization credentials are required for this build')
}
module.exports = {
  ...build,
  mac: { ...build.mac, ...(signed ? {} : { identity: '-' }), hardenedRuntime: signed, notarize: signed && notarized },
}

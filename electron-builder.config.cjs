const { build } = require('./package.json')
// GitHub injects missing secrets as empty strings; builder interprets an empty
// certificate path as the working directory unless the variable is absent.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  if (process.env[name] === '') delete process.env[name]
}
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const notarized = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
if (process.platform === 'darwin' && process.env.AI_OLD_REQUIRE_NOTARIZATION === 'true' && (!signed || !notarized)) {
  throw new Error('Developer ID and Apple notarization credentials are required for this build')
}
module.exports = {
  ...build,
  mac: { ...build.mac, ...(signed ? {} : { identity: '-' }), hardenedRuntime: signed, notarize: signed && notarized },
}

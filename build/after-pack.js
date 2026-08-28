// build/after-pack.js
// Ad-hoc signs the macOS bundle when there is no real signing identity.
//
// Why this exists: with no Developer ID in the keychain, electron-builder logs
// "skipped macOS application code signing" and does nothing. What ships is then
// a bundle carrying only the linker's ad-hoc signature on the main executable,
// with no sealed resources — `spctl -a` rejects it with "code has no resources
// but signature indicates they must be present", and macOS can refuse to launch
// it. For a demo artefact whose entire job is to be run by someone else, that is
// a broken deliverable.
//
// `codesign --sign -` seals the bundle properly. This is NOT a substitute for a
// Developer ID: a dmg downloaded from the internet still carries a quarantine
// flag, and without notarisation Gatekeeper will still block first launch. It
// only makes the bundle well-formed. See the README's packaging notes.
//
// If a real identity IS configured, this hook stays out of the way.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const options = context.packager.platformSpecificBuildOptions || {};
  const hasIdentity =
    options.identity ||
    process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true';

  if (hasIdentity) {
    console.log('  • after-pack: a signing identity is configured, leaving the signature alone');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  try {
    // --deep is deprecated for distribution signing but is the right tool for
    // an ad-hoc pass over the nested helpers and frameworks Electron ships.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
    console.log(`  • after-pack: ad-hoc signed ${path.basename(appPath)} (no identity available)`);
  } catch (err) {
    // Don't fail the build — an unsealed bundle is still worth producing, and
    // the warning tells whoever runs the build what they are getting.
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    console.warn(`  • after-pack: ad-hoc signing failed, bundle left unsealed — ${detail}`);
  }
};

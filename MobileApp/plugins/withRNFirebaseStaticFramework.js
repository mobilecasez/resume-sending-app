// Expo config plugin: sets `$RNFirebaseAsStaticFramework = true` in the iOS Podfile.
// Required when using `useFrameworks: "static"` with @react-native-firebase — otherwise the RNFB
// pods build as framework modules that include non-modular React-Core headers, failing the build
// with `-Wnon-modular-include-in-framework-module`. This makes them static libraries instead. Safe,
// additive, iOS-only.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withRNFirebaseStaticFramework(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      try {
        let contents = fs.readFileSync(podfile, 'utf8');
        if (!contents.includes('$RNFirebaseAsStaticFramework')) {
          contents = '$RNFirebaseAsStaticFramework = true\n' + contents;
          fs.writeFileSync(podfile, contents);
        }
      } catch (e) {
        console.warn('[withRNFirebaseStaticFramework] could not patch Podfile:', e.message);
      }
      return cfg;
    },
  ]);
};

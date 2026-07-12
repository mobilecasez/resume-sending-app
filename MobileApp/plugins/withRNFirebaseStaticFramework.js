// Expo config plugin: makes @react-native-firebase build under `useFrameworks: "static"`.
// Two patches to the iOS Podfile:
//   1) $RNFirebaseAsStaticFramework = true  — build the Firebase SDK pods as static libs.
//   2) CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES = YES (in post_install) — the RNFBApp
//      bridge pod is still a framework module under use_frameworks and includes non-modular
//      React-Core headers (RCTConvert.h / RCTBridgeModule.h …), which otherwise fails the build with
//      `-Werror,-Wnon-modular-include-in-framework-module`. This downgrades that to allowed.
// Safe, additive, iOS-only.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withRNFirebaseStaticFramework(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      try {
        let c = fs.readFileSync(podfile, 'utf8');
        if (!c.includes('$RNFirebaseAsStaticFramework')) {
          c = '$RNFirebaseAsStaticFramework = true\n' + c;
        }
        const marker = 'post_install do |installer|';
        if (c.includes(marker) && !c.includes('CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES')) {
          c = c.replace(
            marker,
            marker +
              '\n    installer.pods_project.targets.each do |__rnfb_t|' +
              '\n      __rnfb_t.build_configurations.each do |__rnfb_c|' +
              "\n        __rnfb_c.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'" +
              '\n      end' +
              '\n    end'
          );
        }
        fs.writeFileSync(podfile, c);
      } catch (e) {
        console.warn('[withRNFirebaseStaticFramework] Podfile patch failed:', e.message);
      }
      return cfg;
    },
  ]);
};

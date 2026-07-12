// Expo config plugin: makes @react-native-firebase build under `useFrameworks: "static"` on iOS.
// Three Podfile patches (all needed for RN Firebase + use_frameworks + New Arch):
//   1) $RNFirebaseAsStaticFramework = true      — build the Firebase SDK pods as static libs.
//   2) use_modular_headers!                     — so React-Core headers are importable as MODULES;
//        without this, RNFBApp (a framework module under use_frameworks) fails with
//        "declaration of 'RCTBridgeModule' must be imported from module 'RNFBApp...' before it is
//        required" (and a cascade of implicit-int / expected ')' parse errors).
//   3) CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES = YES (post_install) — belt-and-braces
//        for any non-modular include that slips through.
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

        // Enable modular headers globally, right after the `platform :ios` line.
        if (!c.includes('use_modular_headers!')) {
          const platformRe = /(platform :ios[^\n]*\n)/;
          if (platformRe.test(c)) {
            c = c.replace(platformRe, '$1use_modular_headers!\n');
          } else {
            c = 'use_modular_headers!\n' + c;
          }
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

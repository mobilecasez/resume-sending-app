const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Enable caching for faster rebuilds
config.transformer = {
  ...config.transformer,
  minifierConfig: {
    keep_classnames: true,
    keep_fnames: true,
    mangle: {
      keep_classnames: true,
      keep_fnames: true,
    },
  },
};

// Reset cache settings for better performance
config.resetCache = false;

// Enable faster refresh
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      // Enable caching headers for assets
      if (req.url.match(/\.(js|json|bundle)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000');
      }
      return middleware(req, res, next);
    };
  },
};

module.exports = config;

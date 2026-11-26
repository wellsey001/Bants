const env = process.env;

export const config = {
  port: Number(env.PORT || 42069),
  dataDir: env.DATA_DIR || './data',
  // If set, new accounts must supply this code to register (keeps your server private).
  inviteCode: env.INVITE_CODE || '',
  // Set to "false" to stop anyone new from registering.
  allowRegistration: (env.ALLOW_REGISTRATION || 'true') !== 'false',
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  // Path to a Firebase service-account JSON file. Push notifications are off if missing.
  fcmServiceAccount: env.FCM_SERVICE_ACCOUNT || '',
  // Set when running behind Cloudflare Tunnel / a reverse proxy so client IPs are read correctly.
  // Free key from developers.giphy.com. GIF search is off without one.
  giphyKey: env.GIPHY_API_KEY || '',
  // Giphy content rating: g, pg, pg-13 or r.
  gifRating: env.GIF_RATING || 'r',
  trustProxy: (env.TRUST_PROXY || 'true') !== 'false',
};
